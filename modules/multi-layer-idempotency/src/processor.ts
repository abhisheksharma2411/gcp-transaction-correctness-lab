// The pipeline one arriving copy of an operation goes through.
//
// Four independent layers can stop a duplicate, and the processor records
// which one did. That record is the point of the whole module: a system that
// is correct only because its outermost layer happened to catch everything is
// one eviction away from being wrong.

import { admits, decide } from "./contract.ts";
import { effectId as deriveEffectId } from "./fingerprint.ts";
import { EffectLedger, SimulatedProvider, type ProviderMode } from "./effects.ts";
import { IdempotencyStore, UniquenessViolation } from "./store.ts";
import type { Decision, OperationContext, Outcome, Tally } from "./types.ts";

/** Which layer refused the duplicate. */
export type CaughtBy =
  | "contract"             // the idempotency record said REPLAY, IN_PROGRESS or CONFLICT
  | "business-uniqueness"  // a different key tried to claim the same business thing
  | "provider"             // the external provider recognised our key
  | "effect-ledger";       // nothing above noticed; the effect itself refused

export interface SubmitResult {
  readonly decision: Decision;
  readonly outcome: Outcome | null;
  readonly response: unknown;
  /** True only when a new externally visible effect was applied. */
  readonly effectApplied: boolean;
  /** Set when this arrival was stopped; null when it did real work. */
  readonly caughtBy: CaughtBy | null;
  readonly detail?: string;
}

export interface ProcessorOptions {
  /** How long a completed record stays authoritative. */
  readonly retentionMs: number;
  /** What the provider does on each fresh call, by operation id. */
  readonly providerMode?: (operationId: string, attempt: number) => ProviderMode;
  /**
   * Negative control only: skip the request-fingerprint comparison, modelling
   * an implementation that keys on the id alone. Never set this in anger --
   * it turns a conflicting request into a silent replay.
   */
  readonly skipFingerprintCheck?: boolean;
}

export class OperationProcessor {
  readonly store: IdempotencyStore;
  readonly effects: EffectLedger;
  readonly provider: SimulatedProvider;
  readonly options: ProcessorOptions;
  readonly tally: Tally = { arrivals: 0, admitted: 0, providerAttempts: 0, effects: 0 };

  constructor(
    options: ProcessorOptions,
    store = new IdempotencyStore(),
    effects = new EffectLedger(),
    provider = new SimulatedProvider(),
  ) {
    this.options = options;
    this.store = store;
    this.effects = effects;
    this.provider = provider;
  }

  /**
   * Handle one arriving copy.
   *
   * `effectKind` names the externally visible thing this operation does. It is
   * part of effect identity, so one operation performing two different effects
   * gets two identities and each is deduplicated separately.
   */
  submit(ctx: OperationContext, nowMs: number, effectKind = "notify"): SubmitResult {
    this.tally.arrivals += 1;

    const record = this.store.get(ctx.operationId);
    // The negative control feeds `decide` the stored fingerprint, which is
    // exactly what an implementation that never compares would effectively do.
    const seen = this.options.skipFingerprintCheck && record !== null
      ? { ...ctx, fingerprint: record.fingerprint }
      : ctx;
    const decision = decide(record, seen, nowMs, this.options.retentionMs);
    this.store.recordArrival(ctx.operationId, ctx.origin, decision, nowMs);

    if (!admits(decision)) {
      // Layer 1 stopped it. REPLAY returns what was recorded; the other two
      // return no response at all, which is the honest answer.
      return {
        decision,
        outcome: record?.outcome ?? null,
        response: decision === "REPLAY" ? record?.response : undefined,
        effectApplied: false,
        caughtBy: "contract",
        detail:
          decision === "CONFLICT"
            ? "same operation id, different request fingerprint"
            : decision === "IN_PROGRESS"
              ? "an earlier copy is still running"
              : "recorded outcome replayed",
      };
    }

    // Layer 2: the business constraint, which does not expire.
    //
    // Reached when the contract admitted the arrival -- either genuinely first,
    // or first-looking because the record was evicted. This is the layer that
    // survives the retention window, and the reason an idempotency key is not
    // a substitute for a uniqueness constraint.
    if (record === null) {
      try {
        this.store.begin(ctx, nowMs);
      } catch (e) {
        if (e instanceof UniquenessViolation) {
          return {
            decision,
            outcome: null,
            response: undefined,
            effectApplied: false,
            caughtBy: "business-uniqueness",
            detail: e.message,
          };
        }
        throw e;
      }
    }

    this.tally.admitted += 1;
    const attempt = this.store.get(ctx.operationId)?.arrivals.length ?? 1;

    // Layer 3: the provider's own idempotency, keyed on something stable.
    const mode = this.options.providerMode?.(ctx.operationId, attempt) ?? "ok";
    const providerKey = ctx.operationId;
    const response = this.provider.call(providerKey, mode, nowMs);
    this.tally.providerAttempts += 1;

    if (response.outcome === "UNKNOWN") {
      // The work may or may not have happened. The operation does not complete;
      // it is left for resolution, which is possible only because the key was
      // stable. Guessing here is how a double charge happens.
      const r = this.store.get(ctx.operationId)!;
      r.completedAtMs = null;
      r.outcome = "UNKNOWN";
      return {
        decision,
        outcome: "UNKNOWN",
        response: undefined,
        effectApplied: false,
        caughtBy: null,
        detail: "provider outcome unknown; operation left open for resolution",
      };
    }

    if (response.outcome === "FAILED_FINAL") {
      this.store.complete(ctx.operationId, "FAILED_FINAL", { error: "provider refused" }, nowMs);
      return {
        decision,
        outcome: "FAILED_FINAL",
        response: { error: "provider refused" },
        effectApplied: false,
        caughtBy: null,
        detail: "a final failure is a recorded outcome, not an invitation to retry",
      };
    }

    // Layer 4: the effect ledger. Last line, and the only one that is about
    // the externally visible thing rather than about bookkeeping.
    const eid = deriveEffectId(ctx.operationId, effectKind);
    const applied = this.effects.apply(eid, ctx.operationId, effectKind, nowMs);

    if (applied === "APPLIED") {
      this.tally.effects += 1;
      const rec = this.store.get(ctx.operationId)!;
      if (!rec.effectIds.includes(eid)) rec.effectIds.push(eid);
    }

    const body = { reference: response.reference, effectId: eid };
    this.store.complete(ctx.operationId, "SUCCEEDED", body, nowMs);

    return {
      decision,
      outcome: "SUCCEEDED",
      response: body,
      effectApplied: applied === "APPLIED",
      caughtBy:
        applied === "DUPLICATE_SUPPRESSED"
          ? "effect-ledger"
          : response.deduplicated
            ? "provider"
            : null,
      detail:
        applied === "DUPLICATE_SUPPRESSED"
          ? "every layer above admitted this; the effect itself refused"
          : response.deduplicated
            ? "the provider recognised our key and did not repeat the work"
            : undefined,
    };
  }

  /**
   * Resolve an operation the provider left unknown.
   *
   * Asks the provider what it did with the stable key. This is the step that
   * turns an unknown into a fact, and it exists only because the key did not
   * change between attempts.
   */
  resolveUnknown(operationId: string, nowMs: number, effectKind = "notify"): SubmitResult {
    const record = this.store.get(operationId);
    if (record === null || record.outcome !== "UNKNOWN") {
      throw new Error(`operation ${operationId} is not awaiting resolution`);
    }
    const found = this.provider.lookup(operationId);
    if (found === null || found.outcome !== "SUCCEEDED") {
      this.store.complete(operationId, "FAILED_FINAL", { error: "provider has no record" }, nowMs);
      return {
        decision: "FIRST",
        outcome: "FAILED_FINAL",
        response: { error: "provider has no record" },
        effectApplied: false,
        caughtBy: null,
        detail: "resolution found no provider record",
      };
    }

    const eid = deriveEffectId(operationId, effectKind);
    const applied = this.effects.apply(eid, operationId, effectKind, nowMs);
    if (applied === "APPLIED") {
      this.tally.effects += 1;
      record.effectIds.push(eid);
    }
    const body = { reference: found.reference, effectId: eid };
    this.store.complete(operationId, "SUCCEEDED", body, nowMs);
    return {
      decision: "FIRST",
      outcome: "SUCCEEDED",
      response: body,
      effectApplied: applied === "APPLIED",
      caughtBy: applied === "DUPLICATE_SUPPRESSED" ? "effect-ledger" : null,
      detail: "resolved from the provider using the stable key",
    };
  }
}
