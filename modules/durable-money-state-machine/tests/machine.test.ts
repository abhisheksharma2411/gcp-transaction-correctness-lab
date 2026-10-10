// Every permitted transition, every representative forbidden one, and the
// invariants that must hold whatever happened.

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, createPayout, replayState, historyIsAppendOnly } from "../src/machine.ts";
import { SPEC_V2, forbiddenPairs } from "../src/spec.ts";
import { SCENARIOS, universalInvariants, T0 } from "../src/scenarios.ts";
import type { Actor, Input, Payout, Trigger } from "../src/types.ts";

const SERVICE = { id: "svc", kind: "service" as const, approvalLimitMinor: 0 };
const PROVIDER = { id: "prov", kind: "provider" as const, approvalLimitMinor: 0 };
const REVIEWER = { id: "reviewer-9", kind: "operator" as const, approvalLimitMinor: 10_000_000 };

function at(state: string, amountMinor: number, token: string | null = null): Payout {
  const base = createPayout({
    id: "p", amountMinor, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  return {
    ...base,
    state: state as Payout["state"],
    callbackToken: token,
    lease: { ownerId: "svc", expiresAtMs: T0 + 3_600_000, takenAtSeq: 0 },
    history: [{ ...base.history[0]!, to: state as Payout["state"], from: state as Payout["state"] }],
  };
}

function input(trigger: Trigger, actor: Actor = SERVICE, token?: string): Input {
  return {
    trigger, actor, correlationId: "corr", expectedVersion: 0,
    ...(token === undefined ? {} : { callbackToken: token }),
  };
}

// --- every permitted transition ---------------------------------------------

/**
 * Each row of the table, driven directly.
 *
 * The scenarios exercise the rows through the runtime; this exercises them
 * through the machine, with the entity placed in the source state by hand. If
 * these two ever disagree, the runtime is adding behaviour the table does not
 * describe.
 */
for (const t of SPEC_V2.transitions) {
  test(`permitted: ${t.from} --${t.trigger}--> ${t.to}`, () => {
    const amount = t.guards.includes("amount-above-auto-limit") ? 900_000 : 25_000;
    const actor =
      t.guards.includes("actor-is-provider") ? PROVIDER
      : t.guards.includes("actor-is-operator") ? REVIEWER
      : SERVICE;
    const token = t.guards.includes("callback-token-matches") ? "cbt-p-live" : undefined;
    const payout = at(t.from, amount, token ?? null);
    const outcome = apply(payout, input(t.trigger, actor, token), T0 + 1_000);
    assert.equal(outcome.kind, "ACCEPTED", `expected ${t.from}/${t.trigger} to be accepted`);
    if (outcome.kind !== "ACCEPTED") return;
    assert.equal(outcome.payout.state, t.to);
    assert.equal(outcome.record.reasonCode, t.reasonCode);
    assert.equal(outcome.payout.version, payout.version + 1);
  });
}

// --- representative forbidden transitions -----------------------------------

const REPRESENTATIVE: readonly { from: string; trigger: Trigger; why: string }[] = [
  { from: "SUBMITTED", trigger: "cancel", why: "money is already in flight" },
  { from: "SUBMITTED", trigger: "submit", why: "a second submission is a second payment" },
  { from: "SUBMITTED", trigger: "review_approve", why: "review does not apply to a submitted payout" },
  { from: "DRAFT", trigger: "submit", why: "nothing has authorized this yet" },
  { from: "DRAFT", trigger: "callback_settled", why: "nothing was submitted, so nothing can call back" },
  { from: "AUTHORIZED", trigger: "timer_expired", why: "no deadline is running here" },
  { from: "MANUAL_REVIEW", trigger: "submit", why: "approval has not been given" },
  { from: "RECONCILING", trigger: "submit", why: "the payout may already have settled" },
];

for (const r of REPRESENTATIVE) {
  test(`forbidden: ${r.from} --${r.trigger}--> nothing (${r.why})`, () => {
    const outcome = apply(at(r.from, 25_000, "cbt-p-live"), input(r.trigger), T0 + 1_000);
    assert.equal(outcome.kind, "REFUSED");
    if (outcome.kind !== "REFUSED") return;
    assert.equal(outcome.reasonCode, "NO_SUCH_TRANSITION");
  });
}

test("the forbidden set is large, and knowing its size is the point", () => {
  const forbidden = forbiddenPairs(SPEC_V2);
  const total = SPEC_V2.states.length * 11;
  const present = new Set(SPEC_V2.transitions.map((t) => `${t.from}/${t.trigger}`)).size;
  assert.equal(forbidden.length + present, total);
  assert.ok(forbidden.length > 4 * present,
    "most combinations should have no row; that is what makes the table a specification");
});

// --- terminal states --------------------------------------------------------

for (const terminal of SPEC_V2.terminal) {
  for (const trigger of ["cancel", "submit", "callback_settled", "review_approve", "timer_expired"] as Trigger[]) {
    test(`terminal: ${terminal} refuses ${trigger}`, () => {
      const outcome = apply(at(terminal, 25_000, "cbt-p-live"), input(trigger, SERVICE, "cbt-p-live"), T0 + 1_000);
      assert.equal(outcome.kind, "REFUSED");
      if (outcome.kind !== "REFUSED") return;
      assert.equal(outcome.reasonCode, "TERMINAL");
    });
  }
}

test("terminal is reported even when the request is also stale", () => {
  // Both the terminal check and the version check would refuse. The terminal
  // answer is the one that tells the caller not to try again. ADR-001.
  const outcome = apply(
    at("SETTLED", 25_000),
    { ...input("cancel"), expectedVersion: 99 },
    T0 + 1_000,
  );
  assert.equal(outcome.kind, "REFUSED");
  if (outcome.kind !== "REFUSED") return;
  assert.equal(outcome.reasonCode, "TERMINAL");
});

// --- concurrency ------------------------------------------------------------

test("a stale version is refused before the table is consulted", () => {
  const outcome = apply(at("AUTHORIZED", 25_000), { ...input("submit"), expectedVersion: 7 }, T0);
  assert.equal(outcome.kind, "REFUSED");
  if (outcome.kind !== "REFUSED") return;
  assert.equal(outcome.reasonCode, "VERSION_CONFLICT");
});

test("an accepted transition always increments the version by exactly one", () => {
  const p = at("AUTHORIZED", 25_000);
  const outcome = apply(p, input("submit"), T0);
  assert.equal(outcome.kind, "ACCEPTED");
  if (outcome.kind !== "ACCEPTED") return;
  assert.equal(outcome.payout.version, p.version + 1);
});

// --- history ----------------------------------------------------------------

test("the history is append-only and the state can be rebuilt from it", () => {
  for (const s of SCENARIOS) {
    const t = s.run();
    assert.ok(historyIsAppendOnly(t.history), `${s.id}: sequence numbers are not dense`);
    assert.equal(replayState(t.history), t.finalState, `${s.id}: stored state disagrees with its history`);
  }
});

test("every accepted transition records an actor, a reason code and a correlation id", () => {
  for (const s of SCENARIOS) {
    for (const r of s.run().history) {
      assert.notEqual(r.actorId, "", `${s.id} seq ${r.seq}`);
      assert.notEqual(r.reasonCode, "", `${s.id} seq ${r.seq}`);
      assert.notEqual(r.correlationId, "", `${s.id} seq ${r.seq}`);
      assert.ok(r.specVersion === 1 || r.specVersion === 2, `${s.id} seq ${r.seq}`);
    }
  }
});

test("the universal invariants hold at the end of every scenario", () => {
  for (const s of SCENARIOS) {
    for (const inv of universalInvariants(s.run())) {
      assert.ok(inv.ok, `${s.id}: ${inv.name}`);
    }
  }
});

test("no scenario produces more than one provider submission", () => {
  for (const s of SCENARIOS) {
    assert.ok(s.run().providerSubmissions <= 1, `${s.id} submitted more than once`);
  }
});
