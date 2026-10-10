// The effect ledger, and the simulated external provider.
//
// Everything above this file is bookkeeping. This is the part of the system
// that is visible from outside -- the message that gets sent, the account that
// gets provisioned -- and it is the only count the article treats as real.

import type { Effect, Outcome } from "./types.ts";

export type ApplyResult = "APPLIED" | "DUPLICATE_SUPPRESSED";

/**
 * The externally visible side effects that have happened.
 *
 * Deduplicates on effect identity rather than operation identity, because one
 * operation can cause several distinct effects and each needs its own answer.
 * This is the last line of defence: if every layer above has failed to notice a
 * duplicate, this still refuses.
 */
export class EffectLedger {
  readonly #applied = new Map<string, Effect>();
  #suppressed = 0;
  /** Negative control only: a ledger that applies whatever it is handed. */
  readonly #deduplicate: boolean;

  constructor(deduplicate = true) {
    this.#deduplicate = deduplicate;
  }

  apply(effectId: string, operationId: string, kind: string, nowMs: number): ApplyResult {
    if (this.#deduplicate && this.#applied.has(effectId)) {
      this.#suppressed += 1;
      return "DUPLICATE_SUPPRESSED";
    }
    // Without de-duplication the same id overwrites, so `count` stops growing;
    // a distinct key keeps each application visible to the negative control.
    const key = this.#deduplicate ? effectId : `${effectId}#${this.#applied.size}`;
    this.#applied.set(key, { effectId, operationId, kind, appliedAtMs: nowMs });
    return "APPLIED";
  }

  has(effectId: string): boolean {
    return this.#applied.has(effectId);
  }

  get deduplicates(): boolean {
    return this.#deduplicate;
  }

  /** Effects actually applied. The number the article cares about. */
  get count(): number {
    return this.#applied.size;
  }

  /** Attempts the ledger refused. Useful evidence; not a failure on its own. */
  get suppressedCount(): number {
    return this.#suppressed;
  }

  countFor(operationId: string): number {
    let n = 0;
    for (const e of this.#applied.values()) if (e.operationId === operationId) n += 1;
    return n;
  }

  all(): readonly Effect[] {
    return [...this.#applied.values()];
  }
}

/**
 * How the simulated provider behaves on a given call.
 *
 * `unknown` is the important one: the provider *did* the work and the caller
 * never found out. That is not a failure mode to be engineered away, it is the
 * normal consequence of a network, and Article 1 is the long version.
 */
export type ProviderMode = "ok" | "unknown" | "fail";

export interface ProviderResponse {
  readonly outcome: Outcome;
  /** Present when the provider is sure. */
  readonly reference?: string;
  /** True when this call hit the provider's own de-duplication. */
  readonly deduplicated: boolean;
}

/**
 * An external provider that honours an idempotency key.
 *
 * Models the contract most payment and messaging providers publish: send the
 * same key twice and the second call returns the first result rather than doing
 * the work again. The model keeps one honest detail -- a call that times out
 * still *happened* at the provider, so the key is already recorded when the
 * caller retries.
 */
export class SimulatedProvider {
  readonly #byKey = new Map<string, { reference: string; outcome: Outcome }>();
  #attempts = 0;

  /**
   * @param key  the caller's idempotency key. Must be stable across retries.
   * @param mode what happens on *this* call. Previous calls are already recorded.
   */
  call(key: string, mode: ProviderMode, nowMs: number): ProviderResponse {
    this.#attempts += 1;

    const prior = this.#byKey.get(key);
    if (prior !== undefined) {
      // The provider recognises the key and does not repeat the work, whatever
      // the caller believed happened last time.
      return { outcome: prior.outcome, reference: prior.reference, deduplicated: true };
    }

    if (mode === "fail") {
      this.#byKey.set(key, { reference: `prov-fail-${nowMs}`, outcome: "FAILED_FINAL" });
      return { outcome: "FAILED_FINAL", deduplicated: false };
    }

    const reference = `prov-${key.slice(0, 12)}`;
    this.#byKey.set(key, { reference, outcome: "SUCCEEDED" });

    if (mode === "unknown") {
      // The work is recorded above; the answer is lost below. The caller gets
      // no reference and cannot tell this apart from "never happened".
      return { outcome: "UNKNOWN", deduplicated: false };
    }
    return { outcome: "SUCCEEDED", reference, deduplicated: false };
  }

  /**
   * Ask the provider what it did with a key.
   *
   * This is only answerable because the key was stable. A caller that generated
   * a fresh key per attempt has nothing to ask about, which is why a key chosen
   * inside the retry loop is worse than no key at all.
   */
  lookup(key: string): ProviderResponse | null {
    const prior = this.#byKey.get(key);
    if (prior === undefined) return null;
    return { outcome: prior.outcome, reference: prior.reference, deduplicated: true };
  }

  get attempts(): number {
    return this.#attempts;
  }
}
