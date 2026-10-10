// The scenarios, in one place, so that the tests and the report run the same
// thing and the transition-coverage figure means something.
//
// Each scenario returns a trace. The tests assert on traces; `scripts/report.ts`
// aggregates them into the coverage table and the crash matrix. Nothing here
// touches a clock: every scenario is handed its instants.

import { Runtime, SERVICE, PROVIDER, operator, worker } from "./runtime.ts";
import type { CrashPoint } from "./runtime.ts";
import { createPayout, replayState, historyIsAppendOnly } from "./machine.ts";
import { claim, sweep } from "./lease.ts";
import { migrateToV2 } from "./migrate.ts";
import { CALLBACK_DEADLINE_MS, LEASE_TTL_MS, REVIEW_DEADLINE_MS } from "./spec.ts";
import type { Payout, RefusalCode, TransitionRecord } from "./types.ts";

export const T0 = Date.UTC(2026, 0, 5);
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const SMALL = 25_000;      // within the auto-approval limit
const LARGE = 900_000;     // over it

export interface Trace {
  readonly finalState: string;
  readonly providerSubmissions: number;
  readonly providerLookups: number;
  /** `FROM--trigger-->TO` for every accepted transition, in order. */
  readonly transitions: readonly string[];
  readonly refusals: readonly RefusalCode[];
  readonly notifications: number;
  readonly recoveries: number;
  readonly history: readonly TransitionRecord[];
  readonly extra: Readonly<Record<string, string | number | boolean>>;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** The required behaviour this scenario is here to demonstrate. */
  readonly covers: string;
  readonly run: () => Trace;
}

function trace(rt: Runtime, payoutId: string, extra: Trace["extra"] = {}): Trace {
  const p = rt.get(payoutId);
  return {
    finalState: p.state,
    providerSubmissions: rt.provider.submissionCount,
    providerLookups: rt.provider.lookupCount,
    transitions: p.history.filter((r) => r.from !== r.to).map((r) => `${r.from}--${r.trigger}-->${r.to}`),
    refusals: rt.refusals.map((r) => r.code),
    notifications: rt.notificationCount,
    recoveries: rt.recoveryCount,
    history: p.history,
    extra,
  };
}

function fresh(
  id: string, amountMinor: number,
  opts: { verdict?: "settled" | "declined"; specVersion?: 1 | 2 } = {},
): { rt: Runtime; p: Payout } {
  const rt = new Runtime(opts.verdict === undefined ? {} : { verdict: opts.verdict });
  const p = rt.create({
    id, amountMinor, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: `create-${id}`,
    ...(opts.specVersion === undefined ? {} : { specVersion: opts.specVersion }),
  });
  return { rt, p };
}

/** Drive a small payout to SUBMITTED. Used by most scenarios. */
function toSubmitted(rt: Runtime, id: string, crashAt?: CrashPoint): string {
  rt.step(id, "authorize", SERVICE, T0 + MINUTE, { correlationId: `auth-${id}` });
  rt.step(id, "submit", SERVICE, T0 + 2 * MINUTE, {
    correlationId: `submit-${id}`, ...(crashAt === undefined ? {} : { crashAt }),
  });
  return rt.get(id).callbackToken ?? "";
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "S01",
    title: "the ordinary life of a payout",
    covers: "every permitted transition; the happy path",
    run: () => {
      const { rt } = fresh("po-001", SMALL);
      const token = toSubmitted(rt, "po-001");
      rt.callback("po-001", "settled", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-001", { token });
    },
  },
  {
    id: "S02",
    title: "the provider declines, and that is an answer",
    covers: "decline path; a terminal state reached without an error",
    run: () => {
      const { rt } = fresh("po-002", SMALL, { verdict: "declined" });
      const token = toSubmitted(rt, "po-002");
      rt.callback("po-002", "declined", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-002");
    },
  },
  {
    id: "S03",
    title: "a large payout is routed to a human",
    covers: "manual-review transition; guards as data",
    run: () => {
      const { rt } = fresh("po-003", LARGE);
      rt.step("po-003", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-003", "review_approve", operator("reviewer-9", 1_000_000), T0 + HOUR, {
        correlationId: "review",
      });
      rt.step("po-003", "submit", SERVICE, T0 + HOUR + MINUTE, { correlationId: "submit" });
      const token = rt.get("po-003").callbackToken ?? "";
      rt.callback("po-003", "settled", token, T0 + 2 * HOUR, "cb-1");
      return trace(rt, "po-003");
    },
  },
  {
    id: "S04",
    title: "a reviewer cannot approve above their own limit",
    covers: "manual review cannot bypass a financial guard",
    run: () => {
      const { rt } = fresh("po-004", LARGE);
      rt.step("po-004", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      // Limit below the amount: refused.
      rt.step("po-004", "review_approve", operator("reviewer-small", 100_000), T0 + HOUR, {
        correlationId: "review-1",
      });
      // The initiator cannot approve their own payout, whatever their limit.
      rt.step("po-004", "review_approve", operator("initiator-1", 10_000_000), T0 + HOUR + 1, {
        correlationId: "review-2",
      });
      return trace(rt, "po-004");
    },
  },
  {
    id: "S05",
    title: "review approval returns to AUTHORIZED, never to a terminal state",
    covers: "manual review cannot bypass a financial guard; review grants permission, not an outcome",
    run: () => {
      const { rt } = fresh("po-005", LARGE);
      rt.step("po-005", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-005", "review_approve", operator("reviewer-9", 1_000_000), T0 + HOUR, {
        correlationId: "review",
      });
      const stateAfterApproval = rt.stateOf("po-005");
      return trace(rt, "po-005", { stateAfterApproval });
    },
  },
  {
    id: "S06",
    title: "a payout in flight cannot be cancelled",
    covers: "representative forbidden transitions; cancellation racing with completion",
    run: () => {
      const { rt } = fresh("po-006", SMALL);
      const token = toSubmitted(rt, "po-006");
      rt.step("po-006", "cancel", SERVICE, T0 + 3 * MINUTE, { correlationId: "cancel" });
      rt.callback("po-006", "settled", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-006");
    },
  },
  {
    id: "S07",
    title: "a duplicate command is refused by the version check",
    covers: "duplicate command; concurrent commands against one entity",
    run: () => {
      const { rt } = fresh("po-007", SMALL);
      rt.step("po-007", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth-1" });
      const versionAfterFirst = rt.get("po-007").version;
      // The same command arrives again, carrying the version it read before.
      rt.step("po-007", "authorize", SERVICE, T0 + MINUTE + 1, {
        correlationId: "auth-1", expectedVersion: versionAfterFirst - 1,
      });
      return trace(rt, "po-007", { versionAfterFirst });
    },
  },
  {
    id: "S08",
    title: "two operators approve the same payout at the same instant",
    covers: "concurrent commands against one entity",
    run: () => {
      const { rt } = fresh("po-008", LARGE);
      rt.step("po-008", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      const v = rt.get("po-008").version;
      rt.step("po-008", "review_approve", operator("reviewer-a", 1_000_000), T0 + HOUR, {
        correlationId: "review-a", expectedVersion: v,
      });
      rt.step("po-008", "review_approve", operator("reviewer-b", 1_000_000), T0 + HOUR, {
        correlationId: "review-b", expectedVersion: v,
      });
      const approvals = rt.get("po-008").history.filter((r) => r.reasonCode === "REVIEW_APPROVED").length;
      return trace(rt, "po-008", { approvals });
    },
  },
  {
    id: "S09",
    title: "a duplicate callback is refused by the token",
    covers: "duplicate callback",
    run: () => {
      const { rt } = fresh("po-009", SMALL);
      const token = toSubmitted(rt, "po-009");
      rt.callback("po-009", "settled", token, T0 + HOUR, "cb-1");
      rt.callback("po-009", "settled", token, T0 + HOUR + 1, "cb-1");
      rt.callback("po-009", "settled", token, T0 + HOUR + 2, "cb-2");
      return trace(rt, "po-009");
    },
  },
  {
    id: "S10",
    title: "a callback for a different submission is not this payout's callback",
    covers: "callback correlation; out-of-order callback",
    run: () => {
      const { rt } = fresh("po-010", SMALL);
      const token = toSubmitted(rt, "po-010");
      rt.callback("po-010", "settled", "cbt-po-010-some-older-submission", T0 + HOUR, "cb-stale");
      rt.callback("po-010", "settled", token, T0 + HOUR + 1, "cb-good");
      return trace(rt, "po-010", { token });
    },
  },
  {
    id: "S11",
    title: "the callback never arrives and the deadline fires",
    covers: "missing callback; timeout; reconciliation",
    run: () => {
      const { rt } = fresh("po-011", SMALL);
      toSubmitted(rt, "po-011");
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 2 * MINUTE);
      const afterTimer = rt.stateOf("po-011");
      rt.resolve("po-011", T0 + CALLBACK_DEADLINE_MS + 3 * MINUTE, "resolve-1");
      return trace(rt, "po-011", { afterTimer });
    },
  },
  {
    id: "S12",
    title: "the timer fires twice",
    covers: "timer fires twice",
    run: () => {
      const { rt } = fresh("po-012", SMALL);
      toSubmitted(rt, "po-012");
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 2 * MINUTE, { duplicate: true });
      const reconcilings = rt.get("po-012").history
        .filter((r) => r.reasonCode === "CALLBACK_DEADLINE_PASSED").length;
      return trace(rt, "po-012", { reconcilings });
    },
  },
  {
    id: "S13",
    title: "the callback arrives after the deadline has already fired",
    covers: "callback arrives after timeout",
    run: () => {
      const { rt } = fresh("po-013", SMALL);
      const token = toSubmitted(rt, "po-013");
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 2 * MINUTE);
      rt.callback("po-013", "settled", token, T0 + CALLBACK_DEADLINE_MS + 10 * MINUTE, "cb-late");
      return trace(rt, "po-013");
    },
  },
  {
    id: "S14",
    title: "the provider has no record and nobody guesses",
    covers: "unknown outcome becomes a human's problem rather than a decision",
    run: () => {
      const { rt } = fresh("po-014", SMALL);
      // Crash between committing SUBMITTED and calling the provider: the
      // payout claims a submission that never happened.
      toSubmitted(rt, "po-014", "after-commit-before-actions");
      rt.recover("po-014", "payout-worker-2", T0 + 2 * MINUTE + LEASE_TTL_MS + 1);
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 10 * MINUTE);
      rt.resolve("po-014", T0 + CALLBACK_DEADLINE_MS + 11 * MINUTE, "resolve-1");
      return trace(rt, "po-014", { submissions: rt.provider.submissionCount });
    },
  },
  {
    id: "S15",
    title: "crash before the transition commits",
    covers: "crash before transition commit",
    run: () => {
      const { rt } = fresh("po-015", SMALL);
      rt.step("po-015", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-015", "submit", SERVICE, T0 + 2 * MINUTE, {
        correlationId: "submit-1", crashAt: "before-commit",
      });
      const afterCrash = rt.stateOf("po-015");
      // The task is redelivered because it was never acknowledged.
      rt.step("po-015", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
      const token = rt.get("po-015").callbackToken ?? "";
      rt.callback("po-015", "settled", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-015", { afterCrash });
    },
  },
  {
    id: "S16",
    title: "crash after the transition commits, before the task is acknowledged",
    covers: "crash after transition commit but before task acknowledgment",
    run: () => {
      const { rt } = fresh("po-016", SMALL);
      rt.step("po-016", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-016", "submit", SERVICE, T0 + 2 * MINUTE, {
        correlationId: "submit-1", crashAt: "after-actions-before-ack",
      });
      const afterCrash = rt.stateOf("po-016");
      // The redelivery finds a payout that has already moved.
      rt.step("po-016", "submit", SERVICE, T0 + 4 * MINUTE, { correlationId: "submit-1" });
      const token = rt.get("po-016").callbackToken ?? "";
      rt.callback("po-016", "settled", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-016", { afterCrash });
    },
  },
  {
    id: "S17",
    title: "a worker dies holding the entity and another takes it over",
    covers: "the indefinitely stuck in-progress record; lease, owner, timeout",
    run: () => {
      const { rt } = fresh("po-017", SMALL);
      rt.step("po-017", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-017", "submit", SERVICE, T0 + 2 * MINUTE, {
        correlationId: "submit-1", crashAt: "after-commit-before-actions",
      });
      // Nothing is wrong with the version: nobody moved it. The lease is what notices.
      const stuckBefore = sweep(rt.all(), T0 + 3 * MINUTE, REVIEW_DEADLINE_MS).length;
      const stuckAfter = sweep(rt.all(), T0 + 2 * MINUTE + LEASE_TTL_MS + 1, REVIEW_DEADLINE_MS);
      const outcome = rt.recover("po-017", "payout-worker-2", T0 + 2 * MINUTE + LEASE_TTL_MS + 2);
      const rearmed = rt.timers.pendingCount;
      return trace(rt, "po-017", {
        stuckBefore,
        stuckAfter: stuckAfter.length,
        stuckReason: stuckAfter[0]?.reason ?? "none",
        outcome,
        rearmed,
      });
    },
  },
  {
    id: "S18",
    title: "a second worker cannot take an entity whose lease is live",
    covers: "lease ownership; concurrent workers",
    run: () => {
      const { rt } = fresh("po-018", SMALL);
      rt.step("po-018", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      const claimed = claim(rt.get("po-018"), "payout-worker-1", T0 + 2 * MINUTE);
      if (claimed.kind === "CLAIMED") rt.put(claimed.payout);
      const second = rt.step("po-018", "submit", worker("payout-worker-2"), T0 + 3 * MINUTE, {
        correlationId: "submit-2",
      });
      const refusedWith = second.outcome.kind === "REFUSED" ? second.outcome.reasonCode : "ACCEPTED";
      rt.step("po-018", "submit", worker("payout-worker-1"), T0 + 4 * MINUTE, { correlationId: "submit-1" });
      return trace(rt, "po-018", { refusedWith });
    },
  },
  {
    id: "S19",
    title: "a terminal payout does not reopen",
    covers: "terminal state cannot silently reopen",
    run: () => {
      const { rt } = fresh("po-019", SMALL);
      const token = toSubmitted(rt, "po-019");
      rt.callback("po-019", "settled", token, T0 + HOUR, "cb-1");
      // Everything anyone might try afterwards.
      rt.step("po-019", "cancel", SERVICE, T0 + 2 * HOUR, { correlationId: "x1" });
      rt.step("po-019", "submit", SERVICE, T0 + 2 * HOUR, { correlationId: "x2" });
      rt.callback("po-019", "declined", token, T0 + 2 * HOUR, "x3");
      rt.step("po-019", "review_approve", operator("reviewer-9", 10_000_000), T0 + 2 * HOUR, {
        correlationId: "x4",
      });
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + DAY);
      return trace(rt, "po-019");
    },
  },
  {
    id: "S20",
    title: "a version 1 payout in flight keeps running under version 1",
    covers: "migration from state-machine version 1 to version 2",
    run: () => {
      const { rt } = fresh("po-020", SMALL, { specVersion: 1 });
      const token = toSubmitted(rt, "po-020");
      const verdict = migrateToV2(rt.get("po-020"), T0 + 3 * MINUTE);
      rt.callback("po-020", "settled", token, T0 + HOUR, "cb-1");
      return trace(rt, "po-020", {
        migration: verdict.kind,
        why: verdict.why,
        ranUnder: rt.get("po-020").specVersion,
      });
    },
  },
  {
    id: "S21",
    title: "a version 1 payout that version 2 would have reviewed is not relabelled",
    covers: "migration from state-machine version 1 to version 2; refusing to rewrite history",
    run: () => {
      const { rt } = fresh("po-021", LARGE, { specVersion: 1 });
      rt.step("po-021", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      const verdict = migrateToV2(rt.get("po-021"), T0 + 2 * MINUTE);
      return trace(rt, "po-021", {
        migration: verdict.kind,
        why: verdict.why,
        stillUnder: rt.get("po-021").specVersion,
      });
    },
  },
  {
    id: "S22",
    title: "a review queue nobody has looked at",
    covers: "every waiting condition has an owner and a deadline",
    run: () => {
      const { rt } = fresh("po-022", LARGE);
      rt.step("po-022", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      const quiet = sweep(rt.all(), T0 + HOUR, REVIEW_DEADLINE_MS).length;
      const overdue = sweep(rt.all(), T0 + REVIEW_DEADLINE_MS + 2 * MINUTE, REVIEW_DEADLINE_MS);
      return trace(rt, "po-022", {
        quiet,
        overdue: overdue.length,
        reason: overdue[0]?.reason ?? "none",
        owner: "payouts-operations",
      });
    },
  },
  {
    id: "S23",
    title: "cancelled before authorization",
    covers: "every permitted transition; cancellation while nothing is promised",
    run: () => {
      const { rt } = fresh("po-023", SMALL);
      rt.step("po-023", "cancel", SERVICE, T0 + MINUTE, { correlationId: "cancel" });
      return trace(rt, "po-023");
    },
  },
  {
    id: "S24",
    title: "cancelled after authorization, before submission",
    covers: "every permitted transition; the last moment cancellation is free",
    run: () => {
      const { rt } = fresh("po-024", SMALL);
      rt.step("po-024", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-024", "cancel", SERVICE, T0 + 2 * MINUTE, { correlationId: "cancel" });
      return trace(rt, "po-024");
    },
  },
  {
    id: "S25",
    title: "a reviewer rejects",
    covers: "every permitted transition; manual review as a terminal route",
    run: () => {
      const { rt } = fresh("po-025", LARGE);
      rt.step("po-025", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-025", "review_reject", operator("reviewer-9", 1_000_000), T0 + HOUR, {
        correlationId: "reject",
      });
      return trace(rt, "po-025");
    },
  },
  {
    id: "S26",
    title: "the requester withdraws a payout sitting in review",
    covers: "every permitted transition; cancellation from a waiting state",
    run: () => {
      const { rt } = fresh("po-026", LARGE);
      rt.step("po-026", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
      rt.step("po-026", "cancel", SERVICE, T0 + 2 * MINUTE, { correlationId: "cancel" });
      return trace(rt, "po-026");
    },
  },
  {
    id: "S27",
    title: "the lookup finds a decline",
    covers: "every permitted transition; reconciliation resolving to a refusal",
    run: () => {
      const { rt } = fresh("po-027", SMALL, { verdict: "declined" });
      toSubmitted(rt, "po-027");
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 2 * MINUTE);
      rt.resolve("po-027", T0 + CALLBACK_DEADLINE_MS + 3 * MINUTE, "resolve-1");
      return trace(rt, "po-027");
    },
  },
  {
    id: "S28",
    title: "a declining callback arrives after the deadline",
    covers: "every permitted transition; callback arrives after timeout",
    run: () => {
      const { rt } = fresh("po-028", SMALL, { verdict: "declined" });
      const token = toSubmitted(rt, "po-028");
      rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 2 * MINUTE);
      rt.callback("po-028", "declined", token, T0 + CALLBACK_DEADLINE_MS + 10 * MINUTE, "cb-late");
      return trace(rt, "po-028");
    },
  },
];

/** Every scenario's trace, keyed by id. Deterministic. */
export function runAll(): ReadonlyMap<string, Trace> {
  const out = new Map<string, Trace>();
  for (const s of SCENARIOS) out.set(s.id, s.run());
  return out;
}

/**
 * The invariants that must hold at the end of every scenario, whatever it did.
 *
 * Checked by the test suite for all of them, and by the report.
 */
export function universalInvariants(t: Trace): readonly { name: string; ok: boolean }[] {
  return [
    { name: "history is append-only", ok: historyIsAppendOnly(t.history) },
    { name: "stored state equals replayed state", ok: replayState(t.history) === t.finalState },
    { name: "at most one provider submission", ok: t.providerSubmissions <= 1 },
    { name: "history is never empty", ok: t.history.length > 0 },
  ];
}

export { createPayout, PROVIDER };
