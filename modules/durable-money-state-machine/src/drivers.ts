// Two places to keep the state, and the question that tells them apart.
//
// A managed orchestrator keeps execution state for you. Workflows will "hold
// state, retry, poll, or wait for up to a year", and an execution's history
// survives restarts of anything you own. That is real and it removes a great
// deal of code.
//
// It is also not permanent, and it is not indexed by your business. Workflows
// documents an execution-retention limit of 90 days for "an execution's
// history and results", and the executions API has a state value, UNAVAILABLE,
// whose entire description is "Execution data is unavailable."
//
// So the comparison below is not orchestration versus a database. Both drivers
// run the *same* transition table. The difference is where the answer to one
// question lives:
//
//     what is the state of payout P?
//
// The database-backed driver answers it from a row keyed by P. The
// engine-backed driver answers it by finding the execution that happens to be
// carrying P and reading its variables -- which works until the execution is
// gone.

import { apply, createPayout } from "./machine.ts";
import { claim } from "./lease.ts";
import type { Payout, Trigger } from "./types.ts";
import { Runtime } from "./runtime.ts";
import type { StepOptions, StepResult } from "./runtime.ts";
import { SERVICE } from "./runtime.ts";
import type { Actor } from "./types.ts";

export interface Driver {
  readonly name: string;
  create(args: Parameters<typeof createPayout>[0]): Payout;
  step(payoutId: string, trigger: Trigger, actor: Actor, nowMs: number, opts: StepOptions): StepResult;
  /** The question. Null means "I cannot tell you." */
  stateOf(payoutId: string): string | null;
}

/** State lives in a row keyed by the business entity. */
export class DatabaseBackedDriver implements Driver {
  readonly name = "database-backed";
  readonly runtime: Runtime;
  constructor(runtime = new Runtime()) { this.runtime = runtime; }
  create(args: Parameters<typeof createPayout>[0]): Payout { return this.runtime.create(args); }
  step(payoutId: string, trigger: Trigger, actor: Actor, nowMs: number, opts: StepOptions): StepResult {
    return this.runtime.step(payoutId, trigger, actor, nowMs, opts);
  }
  stateOf(payoutId: string): string | null {
    return this.runtime.store.has(payoutId) ? this.runtime.get(payoutId).state : null;
  }
}

/**
 * State lives inside an orchestration execution.
 *
 * The execution is keyed by its own identifier, carries the entity in its
 * variables, and is subject to the engine's retention. `expireExecutions`
 * models what the 90-day limit does to anybody who asked the engine for the
 * answer.
 */
export class EngineBackedDriver implements Driver {
  readonly name = "engine-backed";
  readonly #executions = new Map<string, { payout: Payout; startedAtMs: number; available: boolean }>();
  readonly #byPayout = new Map<string, string>();
  #nextExecution = 1;

  create(args: Parameters<typeof createPayout>[0]): Payout {
    const p = createPayout(args);
    const executionId = `exec-${String(this.#nextExecution).padStart(5, "0")}`;
    this.#nextExecution += 1;
    this.#executions.set(executionId, { payout: p, startedAtMs: args.createdAtMs, available: true });
    this.#byPayout.set(p.id, executionId);
    return p;
  }

  step(payoutId: string, trigger: Trigger, actor: Actor, nowMs: number, opts: StepOptions): StepResult {
    const executionId = this.#byPayout.get(payoutId);
    const exec = executionId === undefined ? undefined : this.#executions.get(executionId);
    if (exec === undefined || !exec.available) {
      return {
        outcome: { kind: "REFUSED", reasonCode: "NO_SUCH_TRANSITION", detail: "execution data is unavailable" },
        committed: false, performed: [], acknowledged: true,
      };
    }
    // An orchestration execution is the exclusive owner of its entity for as
    // long as it runs, so the lease is implicit rather than absent.
    const claimed = claim(exec.payout, actor.id, nowMs);
    if (claimed.kind === "CLAIMED") exec.payout = claimed.payout;
    const outcome = apply(exec.payout, {
      trigger, actor,
      correlationId: opts.correlationId,
      expectedVersion: opts.expectedVersion ?? exec.payout.version,
      ...(opts.callbackToken === undefined ? {} : { callbackToken: opts.callbackToken }),
    }, nowMs);
    if (outcome.kind === "ACCEPTED") exec.payout = outcome.payout;
    return {
      outcome,
      committed: outcome.kind === "ACCEPTED",
      performed: outcome.kind === "ACCEPTED" ? outcome.effects : [],
      acknowledged: true,
    };
  }

  stateOf(payoutId: string): string | null {
    const executionId = this.#byPayout.get(payoutId);
    if (executionId === undefined) return null;
    const exec = this.#executions.get(executionId);
    if (exec === undefined || !exec.available) return null;
    return exec.payout.state;
  }

  /**
   * Age out execution history, the way the engine's retention limit does.
   *
   * Workflows states the limit as 90 days for "an execution's history and
   * results". Nothing is lost that the engine promised to keep. The entity is
   * simply no longer something the engine can be asked about.
   */
  expireExecutions(nowMs: number, retentionMs: number): number {
    let expired = 0;
    for (const exec of this.#executions.values()) {
      if (exec.available && nowMs - exec.startedAtMs >= retentionMs) {
        exec.available = false;
        expired += 1;
      }
    }
    return expired;
  }

  get executionCount(): number { return this.#executions.size; }
}

/**
 * Run one scripted lifecycle on a driver and ask it the question afterwards.
 *
 * Both drivers get the same script and the same clock. The only variable is
 * where the answer is kept.
 */
export function runLifecycle(
  driver: Driver, payoutId: string, t0: number, amountMinor = 25_000,
): { readonly finalState: string | null; readonly steps: number } {
  driver.create({
    id: payoutId, amountMinor, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: t0, correlationId: `create-${payoutId}`,
  });
  let steps = 0;
  const go = (trigger: Trigger, actor: Actor, atMs: number, token?: string): void => {
    const r = driver.step(payoutId, trigger, actor, atMs, {
      correlationId: `${trigger}-${payoutId}`,
      ...(token === undefined ? {} : { callbackToken: token }),
    });
    if (r.outcome.kind === "ACCEPTED") steps += 1;
  };
  go("authorize", SERVICE, t0 + 1_000);
  go("submit", SERVICE, t0 + 2_000);
  return { finalState: driver.stateOf(payoutId), steps };
}
