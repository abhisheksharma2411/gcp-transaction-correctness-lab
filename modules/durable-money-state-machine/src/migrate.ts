// Changing the machine while entities are running under the old one.
//
// Google Cloud Workflows answers this question by pinning: "Updating a
// workflow does not affect in-progress executions. Only future executions of
// the workflow will use the updated configuration." Deploying a new definition
// does not reach into an execution that has already started.
//
// Temporal answers it by replay, and therefore forbids changes that would make
// the replay disagree with the recorded history: "The Workflow Definition can
// change in very limited ways once there is a Workflow Execution depending on
// it," and a command that does not match the recorded event history produces a
// non-determinism error.
//
// Both answers have the same consequence for anybody writing the business
// logic: more than one version of the process is alive at once, and the code
// has to know which version each entity is running. Pinning does not remove
// the problem; it moves it from the engine into your table, where at least it
// is visible. This file is what visibility looks like.

import { SPECS } from "./spec.ts";
import { TERMINAL_OF } from "./policy.ts";
import { specFor } from "./machine.ts";
import type { Payout, State, TransitionRecord } from "./types.ts";

export type MigrationVerdict =
  | { readonly kind: "MIGRATED"; readonly payout: Payout; readonly why: string }
  | { readonly kind: "PINNED"; readonly why: string }
  | { readonly kind: "BLOCKED"; readonly why: string };

/**
 * Move one entity from specification version 1 to version 2.
 *
 * Three answers, and the second is the one that matters:
 *
 *  - MIGRATED: the entity is in a state both versions agree about, and nothing
 *    version 2 would have decided differently has happened yet.
 *  - PINNED: the entity is mid-flight. It keeps running under version 1 until
 *    it reaches a terminal state. Nothing is wrong; it is just not ours to
 *    reinterpret.
 *  - BLOCKED: version 2 does not have a state version 1 used, or version 1
 *    already made a decision version 2 forbids. Migrating would rewrite
 *    history, so it is refused and reported.
 *
 * The thing this deliberately does not do is relabel. A payout version 1
 * auto-approved at a million minor units is not a payout version 2 approved;
 * version 2 would have sent it to a human. Changing its `specVersion` would
 * make the history claim a decision that was never taken.
 */
export function migrateToV2(payout: Payout, nowMs: number): MigrationVerdict {
  if (payout.specVersion === 2) return { kind: "PINNED", why: "already on version 2" };

  const v1 = SPECS[1];
  const v2 = SPECS[2];

  if (TERMINAL_OF(v1).has(payout.state)) {
    // A finished entity has no future transitions, so the version it finished
    // under is a fact about the past. Relabelling it would lose that fact.
    return { kind: "PINNED", why: `terminal in ${payout.state}; the version that decided it is history` };
  }

  if (!v2.states.includes(payout.state)) {
    return { kind: "BLOCKED", why: `version 2 has no state ${payout.state}` };
  }

  if (payout.state === "DRAFT") {
    // Nothing has been decided. Version 2 may take it from here, including
    // routing it to review if the amount is over the limit -- which is the
    // whole reason version 2 exists.
    return {
      kind: "MIGRATED",
      payout: { ...payout, specVersion: 2, history: [...payout.history, note(payout, nowMs, "MIGRATED_V1_TO_V2")] },
      why: "no decision has been taken yet",
    };
  }

  if (payout.state === "AUTHORIZED" && decidedUnderV1(payout, "AUTO_APPROVED") &&
      payout.amountMinor > 500_000) {
    return {
      kind: "BLOCKED",
      why: "version 1 auto-approved an amount version 2 would have sent to review; migrating would claim a review that never happened",
    };
  }

  return { kind: "PINNED", why: `in flight in ${payout.state}; finishes under version ${payout.specVersion}` };
}

function decidedUnderV1(payout: Payout, reasonCode: string): boolean {
  return payout.history.some((r) => r.specVersion === 1 && r.reasonCode === reasonCode);
}

function note(payout: Payout, nowMs: number, reasonCode: string): TransitionRecord {
  const state: State = payout.state;
  return {
    seq: payout.history.length,
    from: state,
    to: state,
    trigger: "authorize",
    actorId: "migration",
    actorKind: "service",
    reasonCode,
    correlationId: `migrate-${payout.id}`,
    atMs: nowMs,
    specVersion: 2,
  };
}

/**
 * What a migration run would do to a population, without doing it.
 *
 * A migration you cannot dry-run against real entities is a migration you find
 * out about in production.
 */
export function migrationPlan(payouts: readonly Payout[], nowMs: number): {
  readonly migrated: readonly string[];
  readonly pinned: readonly string[];
  readonly blocked: readonly { id: string; why: string }[];
} {
  const migrated: string[] = [];
  const pinned: string[] = [];
  const blocked: { id: string; why: string }[] = [];
  for (const p of [...payouts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const v = migrateToV2(p, nowMs);
    if (v.kind === "MIGRATED") migrated.push(p.id);
    else if (v.kind === "PINNED") pinned.push(p.id);
    else blocked.push({ id: p.id, why: v.why });
  }
  return { migrated, pinned, blocked };
}

/** The specification an entity is actually running under, whatever is deployed. */
export function runningSpecVersion(payout: Payout): 1 | 2 {
  return specFor(payout).version;
}
