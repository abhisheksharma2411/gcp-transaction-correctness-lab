// Durable timers and callback correlation.
//
// The timer tests model what Cloud Tasks documents: at-least-once delivery,
// name-based deduplication, and a dispatch deadline that cancels the request
// rather than the worker. The callback tests model one submission's token
// being the only thing that makes an arriving callback *this* payout's answer.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TimerQueue } from "../src/timers.ts";
import { Runtime, SERVICE } from "../src/runtime.ts";
import { CALLBACK_DEADLINE_MS, CALLBACK_TIMER } from "../src/spec.ts";
import { SCENARIOS, T0, MINUTE, HOUR } from "../src/scenarios.ts";

function submitted(): { rt: Runtime; token: string } {
  const rt = new Runtime();
  rt.create({
    id: "k", amountMinor: 25_000, currency: "EUR", initiatorId: "initiator-1",
    createdAtMs: T0, correlationId: "c",
  });
  rt.step("k", "authorize", SERVICE, T0 + MINUTE, { correlationId: "auth" });
  rt.step("k", "submit", SERVICE, T0 + 2 * MINUTE, { correlationId: "submit" });
  return { rt, token: rt.get("k").callbackToken ?? "" };
}

// --- the queue --------------------------------------------------------------

test("a named timer cannot be created twice", () => {
  const q = new TimerQueue();
  const t = { name: CALLBACK_TIMER, payoutId: "p", fireAtMs: T0 + HOUR, createdAtMs: T0 };
  assert.equal(q.schedule(t), "CREATED");
  assert.equal(q.schedule(t), "ALREADY_EXISTS");
  assert.equal(q.duplicateCreateCount, 1);
});

test("a name stays used after the timer has fired", () => {
  const q = new TimerQueue();
  const t = { name: CALLBACK_TIMER, payoutId: "p", fireAtMs: T0 + HOUR, createdAtMs: T0 };
  q.schedule(t);
  q.deliver(t);
  assert.equal(q.schedule(t), "ALREADY_EXISTS", "a fired name is not immediately reusable");
});

test("timers are due only once their scheduled time has passed", () => {
  const q = new TimerQueue();
  q.schedule({ name: CALLBACK_TIMER, payoutId: "p", fireAtMs: T0 + HOUR, createdAtMs: T0 });
  assert.equal(q.due(T0 + HOUR - 1).length, 0);
  assert.equal(q.due(T0 + HOUR).length, 1);
});

test("cancelling removes a pending timer", () => {
  const q = new TimerQueue();
  q.schedule({ name: CALLBACK_TIMER, payoutId: "p", fireAtMs: T0 + HOUR, createdAtMs: T0 });
  assert.equal(q.cancel("p", CALLBACK_TIMER), true);
  assert.equal(q.pendingCount, 0);
  assert.equal(q.cancel("p", CALLBACK_TIMER), false);
});

// --- the machine's side -----------------------------------------------------

test("entering SUBMITTED arms the deadline, and leaving it cancels the deadline", () => {
  const { rt, token } = submitted();
  assert.equal(rt.timers.pendingCount, 1);
  rt.callback("k", "settled", token, T0 + HOUR, "cb");
  assert.equal(rt.timers.pendingCount, 0, "a settled payout is not waiting for anything");
});

test("the deadline is computed from the recorded entry time, not the caller's clock", () => {
  const { rt } = submitted();
  const due = rt.timers.due(T0 + 2 * MINUTE + CALLBACK_DEADLINE_MS);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.fireAtMs, T0 + 2 * MINUTE + CALLBACK_DEADLINE_MS);
});

test("the timer fires twice and the payout moves once", () => {
  const { rt } = submitted();
  const applied = rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 5 * MINUTE, { duplicate: true });
  assert.equal(applied, 1, "the second delivery found a payout that had already moved");
  assert.equal(rt.stateOf("k"), "RECONCILING");
  const moves = rt.get("k").history.filter((r) => r.reasonCode === "CALLBACK_DEADLINE_PASSED").length;
  assert.equal(moves, 1);
});

test("a timer that fires against a finished payout is a refusal, not an error", () => {
  const { rt, token } = submitted();
  rt.callback("k", "settled", token, T0 + HOUR, "cb");
  // Re-arm by hand, as a stale queued task would.
  rt.timers.schedule({ name: "stale", payoutId: "k", fireAtMs: T0 + 2 * HOUR, createdAtMs: T0 });
  assert.equal(rt.runDueTimers(T0 + 3 * HOUR), 0);
  assert.equal(rt.stateOf("k"), "SETTLED");
});

// --- callback correlation ---------------------------------------------------

test("a callback carrying the wrong token is not this payout's callback", () => {
  const { rt } = submitted();
  const r = rt.callback("k", "settled", "cbt-k-some-other-submission", T0 + HOUR, "cb");
  assert.equal(r.outcome.kind, "REFUSED");
  if (r.outcome.kind !== "REFUSED") return;
  assert.equal(r.outcome.reasonCode, "CALLBACK_UNCORRELATED");
  assert.equal(rt.stateOf("k"), "SUBMITTED");
});

test("a callback with no token at all is refused", () => {
  const { rt } = submitted();
  const r = rt.step("k", "callback_settled", { id: "p", kind: "provider", approvalLimitMinor: 0 },
    T0 + HOUR, { correlationId: "cb" });
  assert.equal(r.outcome.kind, "REFUSED");
});

test("the second copy of a callback finds a terminal payout", () => {
  const { rt, token } = submitted();
  rt.callback("k", "settled", token, T0 + HOUR, "cb-1");
  const second = rt.callback("k", "settled", token, T0 + HOUR + 1, "cb-1");
  assert.equal(second.outcome.kind, "REFUSED");
  if (second.outcome.kind !== "REFUSED") return;
  assert.equal(second.outcome.reasonCode, "TERMINAL");
});

test("the token is cleared when the payout stops waiting for an answer", () => {
  const { rt, token } = submitted();
  assert.notEqual(token, "");
  rt.callback("k", "settled", token, T0 + HOUR, "cb");
  assert.equal(rt.get("k").callbackToken, null);
});

test("the token survives the move into RECONCILING, because the wait has not ended", () => {
  const { rt, token } = submitted();
  rt.runDueTimers(T0 + CALLBACK_DEADLINE_MS + 5 * MINUTE);
  assert.equal(rt.stateOf("k"), "RECONCILING");
  assert.equal(rt.get("k").callbackToken, token);
});

test("a callback arriving after the deadline is late, not invalid", () => {
  const t = SCENARIOS.find((s) => s.id === "S13")!.run();
  assert.equal(t.finalState, "SETTLED");
  assert.equal(t.providerSubmissions, 1);
  const late = t.history.filter((r) => r.reasonCode === "LATE_CALLBACK_ACCEPTED").length;
  assert.equal(late, 1);
});

test("an out-of-order callback does not displace the right one", () => {
  const t = SCENARIOS.find((s) => s.id === "S10")!.run();
  assert.equal(t.finalState, "SETTLED");
  assert.ok(t.refusals.includes("CALLBACK_UNCORRELATED"));
});
