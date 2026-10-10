// The runtime: a store, a provider, a callback endpoint, and a crash switch.
//
// The point of the runtime is not realism. It is to let a test decide exactly
// where a process dies and then ask what the recorded state says afterwards.

import { apply, createPayout, specFor } from "./machine.ts";
import { TERMINAL_OF } from "./policy.ts";
import type { Mutation } from "./policy.ts";
import { claim, release, WAITING_STATES } from "./lease.ts";
import { TimerQueue } from "./timers.ts";
import type { Timer } from "./timers.ts";
import { CALLBACK_TIMER, standingEffects } from "./spec.ts";
import type { Actor, Effect, Input, Outcome, Payout, RefusalCode, Trigger } from "./types.ts";

/**
 * Where a process can die during one step.
 *
 * The order of operations is: decide, commit the new state, perform the
 * actions, acknowledge the delivery that caused the step. Each gap between
 * those is a crash point, and each produces a different recorded state.
 */
export type CrashPoint =
  | "none"
  | "before-commit"
  | "after-commit-before-actions"
  | "after-actions-before-ack";

export const CRASH_POINTS: readonly CrashPoint[] = [
  "none", "before-commit", "after-commit-before-actions", "after-actions-before-ack",
];

export interface StepResult {
  readonly outcome: Outcome;
  /** False when the crash point stopped the new state from being persisted. */
  readonly committed: boolean;
  /** Actions that were actually performed, as opposed to merely returned. */
  readonly performed: readonly Effect[];
  /** False when the step died before acknowledging its delivery, so it will be redelivered. */
  readonly acknowledged: boolean;
}

/** What the provider says when asked about a token it may or may not have seen. */
export type LookupAnswer = "lookup_settled" | "lookup_declined" | "lookup_indeterminate";

/**
 * A deterministic provider.
 *
 * It counts raw submissions and deduplicates on nothing. That is deliberate:
 * provider-side idempotency is a real and necessary layer and it belongs to
 * the idempotency article. Leaving it out here means that when a crash
 * scenario still produces exactly one submission, the recorded state is
 * demonstrably the thing that prevented the second one.
 */
export class ProviderSimulator {
  readonly #submissions: string[] = [];
  readonly #verdicts = new Map<string, "settled" | "declined">();
  #lookups = 0;

  submit(payoutId: string, token: string, verdict: "settled" | "declined"): void {
    this.#submissions.push(`${payoutId}/${token}`);
    this.#verdicts.set(token, verdict);
  }

  /**
   * Ask what happened to a token.
   *
   * A token the provider has no record of is reported as indeterminate rather
   * than as "did not happen". "I have no record" and "it did not happen" are
   * different statements, and a system that treats them as one will eventually
   * resubmit something that worked.
   */
  lookup(token: string): LookupAnswer {
    this.#lookups += 1;
    const v = this.#verdicts.get(token);
    if (v === "settled") return "lookup_settled";
    if (v === "declined") return "lookup_declined";
    return "lookup_indeterminate";
  }

  get submissionCount(): number { return this.#submissions.length; }
  get submissions(): readonly string[] { return this.#submissions; }
  get lookupCount(): number { return this.#lookups; }
}

export const SERVICE: Actor = { id: "payout-worker-1", kind: "service", approvalLimitMinor: 0 };
export function worker(id: string): Actor {
  return { id, kind: "service", approvalLimitMinor: 0 };
}
export const PROVIDER: Actor = { id: "provider-callback", kind: "provider", approvalLimitMinor: 0 };
export function operator(id: string, approvalLimitMinor: number): Actor {
  return { id, kind: "operator", approvalLimitMinor };
}

export interface RuntimeOptions {
  /** What the provider will say about anything submitted to it. */
  readonly verdict?: "settled" | "declined";
  /** A deliberate defect, for the negative controls. */
  readonly mutation?: Mutation;
}

export interface StepOptions {
  readonly correlationId: string;
  readonly callbackToken?: string;
  readonly crashAt?: CrashPoint;
  /** Act on a version other than the stored one, to exercise the concurrency check. */
  readonly expectedVersion?: number;
  /**
   * Whether the worker takes a lease before acting. Defaults to true for
   * service actors. Set false to exercise an unleased write.
   */
  readonly takeLease?: boolean;
}

export class Runtime {
  readonly store = new Map<string, Payout>();
  readonly timers = new TimerQueue();
  readonly provider = new ProviderSimulator();
  readonly #verdict: "settled" | "declined";
  readonly #mutation: Mutation | undefined;
  /** Every refusal, so a test can assert on *which* check refused. */
  readonly refusals: { payoutId: string; trigger: Trigger; code: RefusalCode }[] = [];
  #notifications = 0;
  #recoveries = 0;

  constructor(opts: RuntimeOptions = {}) {
    this.#verdict = opts.verdict ?? "settled";
    this.#mutation = opts.mutation;
  }

  create(args: Parameters<typeof createPayout>[0]): Payout {
    const p = createPayout(args);
    this.store.set(p.id, p);
    return p;
  }

  get(id: string): Payout {
    const p = this.store.get(id);
    if (p === undefined) throw new Error(`no payout ${id}`);
    return p;
  }

  put(p: Payout): void { this.store.set(p.id, p); }
  all(): readonly Payout[] { return [...this.store.values()]; }

  get notificationCount(): number { return this.#notifications; }
  get recoveryCount(): number { return this.#recoveries; }

  /** A payout's state as the store has it; the only authoritative answer. */
  stateOf(id: string): string { return this.get(id).state; }

  isTerminal(id: string): boolean {
    const p = this.get(id);
    return TERMINAL_OF(specFor(p)).has(p.state);
  }

  /**
   * One step of the machine, with an optional crash.
   *
   * Commit first, then perform the actions. The alternative -- call the
   * provider and then write the state -- moves the window to a worse place: a
   * crash there leaves a payout in AUTHORIZED with money already moving, and
   * the next worker submits it again. Committing first can leave a payout in
   * SUBMITTED with nothing submitted, which is a claim the deadline catches.
   */
  step(payoutId: string, trigger: Trigger, actor: Actor, nowMs: number, opts: StepOptions): StepResult {
    let before = this.get(payoutId);

    // Take the lease, if this actor needs one. A worker that cannot claim the
    // entity does not act on it; that is the whole point of the claim.
    const wantsLease = opts.takeLease ?? actor.kind === "service";
    if (wantsLease && before.state !== "DRAFT" && !TERMINAL_OF(specFor(before)).has(before.state)) {
      const c = claim(before, actor.id, nowMs);
      if (c.kind === "HELD_BY_OTHER") {
        this.refusals.push({ payoutId, trigger, code: "LEASE_NOT_HELD" });
        return {
          outcome: { kind: "REFUSED", reasonCode: "LEASE_NOT_HELD", detail: `held by ${c.ownerId}` },
          committed: false, performed: [], acknowledged: true,
        };
      }
      if (c.kind === "CLAIMED") {
        before = c.payout;
        this.put(before);
      }
    }

    const input: Input = {
      trigger,
      actor,
      correlationId: opts.correlationId,
      expectedVersion: opts.expectedVersion ?? before.version,
      ...(opts.callbackToken === undefined ? {} : { callbackToken: opts.callbackToken }),
    };
    const outcome: Outcome = apply(before, input, nowMs, this.#mutation);

    if (outcome.kind === "REFUSED") {
      this.refusals.push({ payoutId, trigger, code: outcome.reasonCode });
      return { outcome, committed: false, performed: [], acknowledged: true };
    }

    const crashAt = opts.crashAt ?? "none";
    if (crashAt === "before-commit") {
      return { outcome, committed: false, performed: [], acknowledged: false };
    }

    this.put(outcome.payout);

    if (crashAt === "after-commit-before-actions") {
      return { outcome, committed: true, performed: [], acknowledged: false };
    }

    const performed = this.#perform(outcome.effects, nowMs);
    this.#reconcileStanding(outcome.payout.id, nowMs);
    this.#handOff(outcome.payout.id, actor.id);

    const acknowledged = crashAt !== "after-actions-before-ack";
    return { outcome, committed: true, performed, acknowledged };
  }

  /**
   * Bring a state's standing conditions into existence.
   *
   * Called after every committed step and by `recover`. It is idempotent by
   * construction: the timer is named after the thing it is a deadline for, so
   * a second create is refused the way the Cloud Tasks API refuses a duplicate
   * task name, and the fire time is computed from the recorded entry time
   * rather than from the caller's clock.
   */
  #reconcileStanding(payoutId: string, nowMs: number): void {
    const p = this.get(payoutId);
    const required = standingEffects(specFor(p), p);
    const requiredNames = new Set(
      required.filter((e) => e.kind === "SCHEDULE_TIMER").map((e) => e.name),
    );
    if (!requiredNames.has(CALLBACK_TIMER)) this.timers.cancel(payoutId, CALLBACK_TIMER);
    for (const e of required) {
      if (e.kind !== "SCHEDULE_TIMER") continue;
      const t: Timer = { name: e.name, payoutId: e.payoutId, fireAtMs: e.fireAtMs, createdAtMs: nowMs };
      this.timers.schedule(t);
    }
  }

  /**
   * Give the lease back when the process is now waiting on somebody outside.
   *
   * Without this, every entity waiting on a provider looks like an entity
   * whose worker died, and the sweep cannot tell the two apart.
   */
  #handOff(payoutId: string, ownerId: string): void {
    const p = this.get(payoutId);
    if ((WAITING_STATES as readonly string[]).includes(p.state)) {
      this.put(release(p, ownerId));
    }
  }

  #perform(effects: readonly Effect[], _nowMs: number): readonly Effect[] {
    const done: Effect[] = [];
    for (const e of effects) {
      switch (e.kind) {
        case "CALL_PROVIDER":
          this.provider.submit(e.payoutId, e.callbackToken, this.#verdict);
          break;
        case "NOTIFY_REVIEWER":
          this.#notifications += 1;
          break;
        case "LOOKUP_PROVIDER":
          break; // the lookup is a separate step, driven by the worker
        case "SCHEDULE_TIMER":
        case "CANCEL_TIMER":
          break; // timers are standing conditions of a state, not one-shot actions
      }
      done.push(e);
    }
    return done;
  }

  /**
   * Resume a process whose worker did not come back.
   *
   * Recovery reads the recorded state and makes that state's standing
   * conditions true again. It does not replay the transition that got the
   * entity here, and it does not re-perform that transition's one-shot
   * actions. Those two sentences are the difference between resuming and
   * restarting, and they are why a crashed submission is not a second payment.
   */
  recover(payoutId: string, ownerId: string, nowMs: number): "RECOVERED" | "HELD_BY_OTHER" | "TERMINAL" {
    const p = this.get(payoutId);
    const c = claim(p, ownerId, nowMs);
    if (c.kind !== "CLAIMED") return c.kind;
    this.put(c.payout);
    this.#reconcileStanding(payoutId, nowMs);
    this.#handOff(payoutId, ownerId);
    this.#recoveries += 1;
    return "RECOVERED";
  }

  /**
   * Fire every timer that is due, optionally delivering each one twice.
   *
   * A timer that fires against an entity which has already moved on is a
   * no-op, which is why the handler is written as a transition attempt rather
   * than as an action: NO_SUCH_TRANSITION is a correct and complete answer to
   * a late deadline.
   */
  runDueTimers(nowMs: number, opts: { duplicate?: boolean } = {}): number {
    let applied = 0;
    for (const timer of this.timers.due(nowMs)) {
      for (const fired of this.timers.deliver(timer, opts.duplicate ?? false)) {
        if (timer.name !== CALLBACK_TIMER) continue;
        const r = this.step(timer.payoutId, "timer_expired", SERVICE, nowMs, {
          correlationId: `timer-${timer.payoutId}-${fired.attempt}`,
        });
        if (r.outcome.kind === "ACCEPTED") applied += 1;
      }
    }
    return applied;
  }

  /** Ask the provider about an entity that is reconciling, then apply the answer. */
  resolve(payoutId: string, nowMs: number, correlationId: string): StepResult {
    const p = this.get(payoutId);
    const answer = this.provider.lookup(p.callbackToken ?? "");
    return this.step(payoutId, answer, SERVICE, nowMs, { correlationId });
  }

  /** Deliver a provider callback, correlated by token. */
  callback(
    payoutId: string, verdict: "settled" | "declined", token: string, nowMs: number, correlationId: string,
  ): StepResult {
    const trigger: Trigger = verdict === "settled" ? "callback_settled" : "callback_declined";
    return this.step(payoutId, trigger, PROVIDER, nowMs, { correlationId, callbackToken: token });
  }
}
