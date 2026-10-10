// The six arrival paths, and the limits of what each one can deduplicate.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeduplicatingQueue, RetryingWorkflow, TaskAlreadyExists,
  TransactionalInbox, WebhookEndpoint, operatorReplay,
} from "../src/boundaries.ts";
import { OperationProcessor } from "../src/processor.ts";
import { fingerprint } from "../src/fingerprint.ts";
import type { OperationContext } from "../src/types.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5);
const PAY = { amount: 2500, currency: "EUR" };

const ctx = (over: Partial<OperationContext> = {}): OperationContext => ({
  operationId: "op-1", businessRef: "ref-1", fingerprint: fingerprint(PAY),
  origin: "api", attempt: 1, ...over,
});

test("B1 an inbox suppresses a repeat of the same message id", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const inbox = new TransactionalInbox();
  inbox.deliver("msg-1", ctx(), p, T0);
  assert.equal(inbox.deliver("msg-1", ctx(), p, T0), "ALREADY_PROCESSED");
  assert.equal(p.effects.count, 1);
});

test("B2 an inbox cannot see a publish-side duplicate", () => {
  // The same payload published twice arrives with two message ids. The inbox
  // sees two messages; only the operation contract knows it is one operation.
  const p = new OperationProcessor({ retentionMs: DAY });
  const inbox = new TransactionalInbox();
  inbox.deliver("msg-1", ctx(), p, T0);
  const second = inbox.deliver("msg-2", ctx(), p, T0);
  assert.notEqual(second, "ALREADY_PROCESSED", "the inbox had nothing to match on");
  assert.equal(inbox.suppressedCount, 0);
  assert.equal(p.effects.count, 1, "the contract caught it");
});

test("B3 a redelivery after a lost acknowledgement still applies one effect", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const inbox = new TransactionalInbox();
  // The effect happened; the ack failed; the inbox row was never committed.
  inbox.deliverWithLostAck("msg-1", ctx(), p, T0);
  const redelivered = inbox.deliver("msg-1", ctx(), p, T0 + 30_000);
  assert.notEqual(redelivered, "ALREADY_PROCESSED");
  assert.equal(p.effects.count, 1);
});

test("B4 a queue refuses a repeated task name inside its window", () => {
  const q = new DeduplicatingQueue(DAY);
  q.enqueue("op-1", "charge", T0);
  assert.throws(() => q.enqueue("op-1", "charge", T0 + HOUR), TaskAlreadyExists);
  assert.equal(q.rejectedCount, 1);
});

test("B5 the de-duplication window is finite, which is the point", () => {
  const q = new DeduplicatingQueue(DAY);
  q.enqueue("op-1", "charge", T0);
  assert.equal(q.wouldAccept("op-1", "charge", T0 + DAY - 1), false);
  assert.equal(q.wouldAccept("op-1", "charge", T0 + DAY), true);
  // Accepted again, as a brand-new task, with no memory of the first.
  assert.doesNotThrow(() => q.enqueue("op-1", "charge", T0 + DAY));
});

test("B6 different steps of one operation get different task names", () => {
  const q = new DeduplicatingQueue(DAY);
  q.enqueue("op-1", "charge", T0);
  assert.doesNotThrow(() => q.enqueue("op-1", "notify", T0));
});

test("B7 a workflow that carries the id produces one effect", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const w = new RetryingWorkflow();
  const results = w.runStep(ctx(), p, T0, { attempts: 4 });
  assert.equal(results.length, 4);
  assert.equal(w.stepAttempts, 4);
  assert.equal(p.effects.count, 1);
  assert.deepEqual(results.map((r) => r.decision), ["FIRST", "REPLAY", "REPLAY", "REPLAY"]);
});

test("B8 a workflow that mints a fresh id per attempt produces three operations", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const w = new RetryingWorkflow();
  const results = w.runStep(ctx(), p, T0, { attempts: 3, regenerateId: true });
  // Every one looks new to the contract. Only the business constraint stops
  // them, and it refuses rather than replaying -- the caller gets an error.
  assert.deepEqual(results.map((r) => r.decision), ["FIRST", "FIRST", "FIRST"]);
  assert.deepEqual(results.map((r) => r.caughtBy), [null, "business-uniqueness", "business-uniqueness"]);
  assert.equal(p.effects.count, 1);
});

test("B9 a webhook endpoint suppresses a repeated event id", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const w = new WebhookEndpoint();
  w.receive("evt-1", ctx(), p, T0);
  assert.equal(w.receive("evt-1", ctx(), p, T0), "DUPLICATE_EVENT");
  assert.equal(w.suppressedCount, 1);
});

test("B10 two different events can describe one operation", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const w = new WebhookEndpoint();
  w.receive("evt-1", ctx(), p, T0);
  const second = w.receive("evt-2", ctx(), p, T0);
  assert.notEqual(second, "DUPLICATE_EVENT");
  assert.equal(p.effects.count, 1);
});

test("B11 operator replay has no de-duplication of its own", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  p.submit(ctx(), T0);
  const replayed = operatorReplay(ctx(), p, T0 + 60_000);
  assert.equal(replayed.decision, "REPLAY");
  assert.equal(replayed.caughtBy, "contract");
  assert.equal(p.effects.count, 1);
});

test("B12 every boundary at once still yields one effect", () => {
  const p = new OperationProcessor({ retentionMs: DAY });
  const inbox = new TransactionalInbox();
  const webhook = new WebhookEndpoint();
  const w = new RetryingWorkflow();

  p.submit(ctx(), T0);
  inbox.deliver("msg-1", ctx({ origin: "inbox" }), p, T0 + 1);
  inbox.deliver("msg-2", ctx({ origin: "inbox" }), p, T0 + 2);
  w.runStep(ctx(), p, T0 + 3, { attempts: 2 });
  webhook.receive("evt-1", ctx(), p, T0 + 5);
  operatorReplay(ctx(), p, T0 + 6);

  assert.equal(p.effects.count, 1);
  assert.ok(p.tally.arrivals >= 7, `arrivals ${p.tally.arrivals}`);
  assert.equal(p.tally.admitted, 1);
});
