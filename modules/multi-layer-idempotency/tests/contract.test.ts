// The decision function. Pure, so every case here is a table row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { admits, decide, retryable } from "../src/contract.ts";
import type { OperationContext, OperationRecord } from "../src/types.ts";

const HOUR = 3_600_000;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return { operationId: "op-1", businessRef: "ref-1", fingerprint: "fp-a", origin: "api", attempt: 1, ...over };
}

function record(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    operationId: "op-1", businessRef: "ref-1", fingerprint: "fp-a",
    startedAtMs: 0, completedAtMs: 1_000, outcome: "SUCCEEDED",
    response: { ok: true }, effectIds: [], arrivals: [], ...over,
  };
}

test("D1 nothing recorded is FIRST", () => {
  assert.equal(decide(null, ctx(), 0, HOUR), "FIRST");
});

test("D2 a finished record inside its window is REPLAY", () => {
  assert.equal(decide(record(), ctx(), 2_000, HOUR), "REPLAY");
});

test("D3 an unfinished record is IN_PROGRESS", () => {
  assert.equal(decide(record({ completedAtMs: null, outcome: null }), ctx(), 2_000, HOUR), "IN_PROGRESS");
});

test("D4 a different fingerprint is CONFLICT", () => {
  assert.equal(decide(record(), ctx({ fingerprint: "fp-b" }), 2_000, HOUR), "CONFLICT");
});

test("D5 a finished record past its window is EXPIRED", () => {
  assert.equal(decide(record(), ctx(), 1_000 + HOUR, HOUR), "EXPIRED");
  // The boundary is inclusive: at exactly the window the record has stopped
  // being authoritative.
  assert.equal(decide(record(), ctx(), 1_000 + HOUR - 1, HOUR), "REPLAY");
});

test("D6 conflict beats expiry — the ordering is the contract", () => {
  // Past the window AND a different request. While the record is in hand the
  // system can still refuse; once evicted it never can. ADR-001.
  assert.equal(decide(record(), ctx({ fingerprint: "fp-b" }), 1_000 + 10 * HOUR, HOUR), "CONFLICT");
});

test("D7 conflict beats in-progress", () => {
  assert.equal(
    decide(record({ completedAtMs: null, outcome: null }), ctx({ fingerprint: "fp-b" }), 100, HOUR),
    "CONFLICT",
  );
});

test("D8 an ancient in-progress record stays IN_PROGRESS", () => {
  // A stuck operation is a lifecycle problem, not a de-duplication one. It
  // must not quietly become available for a second run.
  assert.equal(
    decide(record({ completedAtMs: null, outcome: null, startedAtMs: 0 }), ctx(), 1000 * HOUR, HOUR),
    "IN_PROGRESS",
  );
});

test("D9 a record for the wrong operation is a programming error", () => {
  assert.throws(() => decide(record({ operationId: "op-9" }), ctx(), 0, HOUR), /op-9/);
});

test("D10 only FIRST and EXPIRED admit work", () => {
  assert.deepEqual(
    (["FIRST", "IN_PROGRESS", "REPLAY", "CONFLICT", "EXPIRED"] as const).map(admits),
    [true, false, false, false, true],
  );
});

test("D11 a conflict is not retryable; in-progress is", () => {
  assert.equal(retryable("IN_PROGRESS"), true);
  assert.equal(retryable("CONFLICT"), false);
  assert.equal(retryable("REPLAY"), false);
});

test("D12 a FAILED_FINAL record replays the failure rather than re-running", () => {
  const r = record({ outcome: "FAILED_FINAL", response: { error: "refused" } });
  assert.equal(decide(r, ctx(), 2_000, HOUR), "REPLAY");
});
