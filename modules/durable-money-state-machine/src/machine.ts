// The machine. One pure function.
//
// No clock, no store, no I/O: `nowMs` is an argument, the entity is an
// argument, and the effects are *returned* rather than performed. That is what
// makes the crash tests possible -- the caller decides whether the effect was
// applied, and the machine never knows the difference.

import { SPECS } from "./spec.ts";
import type { Spec, Transition } from "./spec.ts";
import { TERMINAL_OF, leaseRequired } from "./policy.ts";
import type { Mutation } from "./policy.ts";
import type {
  Effect, Input, Outcome, Payout, RefusalCode, State, TransitionRecord, Trigger,
} from "./types.ts";

export function specFor(payout: Payout): Spec {
  return SPECS[payout.specVersion];
}

/**
 * Attempt one transition.
 *
 * The order of the checks is part of the contract. See ADR-001 for the one
 * ordering decision that is genuinely contested.
 *
 * `mutation` exists so that the negative controls can remove one check at a
 * time and confirm that named scenarios go red. Production code would not
 * carry this parameter; a module that claims its tests measure something has
 * to be able to show it.
 */
export function apply(
  payout: Payout, input: Input, nowMs: number, mutation?: Mutation,
): Outcome {
  const spec = specFor(payout);

  // 1. Terminal first.
  //
  // A finished payout is finished regardless of what else is wrong with the
  // request. Reporting TERMINAL rather than NO_SUCH_TRANSITION or
  // VERSION_CONFLICT tells the caller the thing it most needs to know: there
  // is no version of this request that will be accepted. See ADR-001.
  if (mutation !== "no-terminal-check" && TERMINAL_OF(spec).has(payout.state)) {
    return refuse("TERMINAL", `${payout.id} is in terminal state ${payout.state}; it does not reopen`);
  }

  // 2. Optimistic concurrency.
  //
  // This answers "did anyone move this since I read it?" It is a point-in-time
  // check and it is cheap. It cannot answer "has anyone been moving this at
  // all?", because a process that stopped leaves the version untouched and
  // satisfies this check forever. That is what the lease is for.
  if (mutation !== "no-version-check" && input.expectedVersion !== payout.version) {
    return refuse(
      "VERSION_CONFLICT",
      `expected version ${input.expectedVersion}, entity is at ${payout.version}`,
    );
  }

  // 3. The lease.
  //
  // A worker resuming a process in flight must hold an unexpired claim on it.
  // Externally driven arrivals -- provider callbacks and operator decisions --
  // do not take a lease; they are not resuming anything.
  if (mutation !== "no-lease-check" && leaseRequired(payout, input)) {
    const lease = payout.lease;
    if (lease === null) {
      return refuse("LEASE_NOT_HELD", `${input.actor.id} holds no lease on ${payout.id}`);
    }
    if (lease.ownerId !== input.actor.id) {
      return refuse("LEASE_NOT_HELD", `lease on ${payout.id} is held by ${lease.ownerId}`);
    }
    if (lease.expiresAtMs <= nowMs) {
      return refuse("LEASE_NOT_HELD", `lease on ${payout.id} expired at ${lease.expiresAtMs}`);
    }
  }

  // 4. Is this pair in the table at all?
  const candidates = spec.transitions.filter(
    (t) => t.from === payout.state && t.trigger === input.trigger,
  );
  if (candidates.length === 0) {
    return refuse(
      "NO_SUCH_TRANSITION",
      `no transition from ${payout.state} on ${input.trigger} in spec v${spec.version}`,
    );
  }

  // 5. Guards. Rows are evaluated in order; the first row whose guards all
  //    pass is taken. Two rows for one pair is a conditional transition, which
  //    is how the amount threshold is expressed as data rather than as an if.
  const failures: string[] = [];
  let chosen: Transition | null = null;
  for (const t of candidates) {
    const failed = mutation === "no-guards" ? null : firstFailure(spec, t, payout, input, nowMs);
    if (failed === null) {
      chosen = t;
      break;
    }
    failures.push(`-> ${t.to}: ${failed.reason}`);
    if (
      failed.guard === "callback-token-matches" &&
      candidates.length === 1 &&
      mutation !== "no-callback-correlation"
    ) {
      return refuse("CALLBACK_UNCORRELATED", failed.reason);
    }
    if (failed.guard === "callback-token-matches" && mutation === "no-callback-correlation") {
      chosen = t;
      break;
    }
  }
  if (chosen === null) {
    return refuse("GUARD_FAILED", failures.join("; "));
  }

  // 6. Accept. Version increments, history appends, effects are returned.
  const record: TransitionRecord = {
    seq: payout.history.length,
    from: payout.state,
    to: chosen.to,
    trigger: input.trigger,
    actorId: input.actor.id,
    actorKind: input.actor.kind,
    reasonCode: chosen.reasonCode,
    correlationId: input.correlationId,
    atMs: nowMs,
    specVersion: spec.version,
  };

  const next: Payout = {
    ...payout,
    state: chosen.to,
    version: payout.version + 1,
    callbackToken: nextToken(payout, chosen, input),
    lease: TERMINAL_OF(spec).has(chosen.to) ? null : payout.lease,
    history: mutation === "history-not-appended"
      ? [...payout.history.slice(0, -1), record]
      : [...payout.history, record],
  };

  const effects: readonly Effect[] = chosen.actions(next, input, nowMs);
  return { kind: "ACCEPTED", payout: next, record, effects };
}

/**
 * The callback token's lifetime.
 *
 * Minted on submission and cleared the moment the payout stops waiting for a
 * provider answer. Workflows' callback endpoints behave the same way at the
 * platform level: the documentation states that callback endpoints "can only
 * be waited on in the workflow execution in which they're created", so a token
 * is scoped to one wait rather than to the entity.
 */
function nextToken(payout: Payout, t: Transition, input: Input): string | null {
  if (t.to === "SUBMITTED") return `cbt-${payout.id}-${input.correlationId}`;
  if (t.to === "RECONCILING") return payout.callbackToken; // still waiting; a late callback is valid
  return null;
}

function firstFailure(
  spec: Spec, t: Transition, payout: Payout, input: Input, nowMs: number,
): { guard: string; reason: string } | null {
  for (const name of t.guards) {
    const guard = spec.guards[name];
    if (guard === undefined) throw new Error(`spec v${spec.version} references unknown guard ${name}`);
    const reason = guard.check(payout, input, nowMs);
    if (reason !== null) return { guard: name, reason };
  }
  return null;
}

function refuse(reasonCode: RefusalCode, detail: string): Outcome {
  return { kind: "REFUSED", reasonCode, detail };
}

// --- construction -----------------------------------------------------------

export function createPayout(args: {
  id: string;
  amountMinor: number;
  currency: string;
  initiatorId: string;
  specVersion?: 1 | 2;
  createdAtMs: number;
  correlationId: string;
}): Payout {
  const specVersion = args.specVersion ?? 2;
  const record: TransitionRecord = {
    seq: 0,
    from: "DRAFT",
    to: "DRAFT",
    trigger: "authorize",
    actorId: args.initiatorId,
    actorKind: "service",
    reasonCode: "CREATED",
    correlationId: args.correlationId,
    atMs: args.createdAtMs,
    specVersion,
  };
  return {
    id: args.id,
    state: "DRAFT",
    version: 0,
    specVersion,
    amountMinor: args.amountMinor,
    currency: args.currency,
    initiatorId: args.initiatorId,
    callbackToken: null,
    lease: null,
    history: [record],
  };
}

// --- history as evidence ----------------------------------------------------

/**
 * Rebuild the state from the history alone.
 *
 * If this ever disagrees with the stored state, the stored state is not
 * evidence of anything. The invariant is checked after every scenario.
 */
export function replayState(history: readonly TransitionRecord[]): State {
  if (history.length === 0) throw new Error("history is empty; an entity always has a creation record");
  let state: State = history[0]!.from;
  for (const r of history) {
    if (r.from !== state) {
      throw new Error(`history is not contiguous at seq ${r.seq}: ${state} then ${r.from}`);
    }
    state = r.to;
  }
  return state;
}

/** Sequence numbers must be dense and monotonic, or the history is not append-only. */
export function historyIsAppendOnly(history: readonly TransitionRecord[]): boolean {
  return history.every((r, i) => r.seq === i);
}

export function triggersOf(spec: Spec): readonly Trigger[] {
  return [...new Set(spec.transitions.map((t) => t.trigger))];
}
