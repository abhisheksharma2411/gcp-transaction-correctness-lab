// The two windows.
//
// A streaming pipeline has an allowed-lateness window; a payment network has a
// correction window. They are set by different people for different reasons
// and nothing connects them. These tests are the evidence for the article's
// central claim: when the first is shorter than the second, evidence is lost,
// and the loss does not show up in the places an operator looks.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Pipeline } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/reconcile.ts";
import { DEFAULT_STREAM, generate } from "../src/stream.ts";
import type { CaseState } from "../src/types.ts";

const T0 = Date.UTC(2026, 0, 5);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const stream = generate(DEFAULT_STREAM, T0);

function run(allowedLatenessMs: number): Pipeline {
  const p = new Pipeline({ allowedLatenessMs, reconcile: DEFAULT_CONFIG });
  p.ingest(stream.records);
  p.close(T0 + 60 * DAY);
  return p;
}

function states(p: Pipeline): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of p.reconciler.cases.values()) {
    out[c.state as CaseState] = (out[c.state] ?? 0) + 1;
  }
  return out;
}

describe("the lateness gate", () => {
  it("drops a record that is behind the watermark by more than the window", () => {
    const p = new Pipeline({ allowedLatenessMs: HOUR, reconcile: DEFAULT_CONFIG });
    p.ingest([
      {
        sourceEventId: "a", source: "gateway", receivedAtMs: T0,
        body: { kind: "CAPTURED", ref: "t1", currency: "EUR", occurredAtMs: T0 + 10 * DAY, grossMinor: 100 },
      },
      {
        sourceEventId: "b", source: "gateway", receivedAtMs: T0 + 1,
        body: { kind: "CAPTURED", ref: "t2", currency: "EUR", occurredAtMs: T0, grossMinor: 100 },
      },
    ]);
    assert.equal(p.tally.droppedLate, 1);
    assert.equal(p.dropped[0]!.ref, "t2");
    assert.equal(p.dropped[0]!.behindByMs, 10 * DAY);
  });

  it("keeps a record exactly on the boundary", () => {
    const p = new Pipeline({ allowedLatenessMs: DAY, reconcile: DEFAULT_CONFIG });
    p.ingest([
      {
        sourceEventId: "a", source: "gateway", receivedAtMs: T0,
        body: { kind: "CAPTURED", ref: "t1", currency: "EUR", occurredAtMs: T0 + DAY, grossMinor: 100 },
      },
      {
        sourceEventId: "b", source: "gateway", receivedAtMs: T0 + 1,
        body: { kind: "CAPTURED", ref: "t2", currency: "EUR", occurredAtMs: T0, grossMinor: 100 },
      },
    ]);
    assert.equal(p.tally.droppedLate, 0);
  });

  it("a dropped record never reaches the ledger", () => {
    const p = new Pipeline({ allowedLatenessMs: 0, reconcile: DEFAULT_CONFIG });
    p.ingest([
      {
        sourceEventId: "a", source: "gateway", receivedAtMs: T0,
        body: { kind: "CAPTURED", ref: "t1", currency: "EUR", occurredAtMs: T0 + DAY, grossMinor: 100 },
      },
      {
        sourceEventId: "b", source: "gateway", receivedAtMs: T0 + 1,
        body: { kind: "CAPTURED", ref: "t2", currency: "EUR", occurredAtMs: T0, grossMinor: 100 },
      },
    ]);
    assert.equal(p.ledger.count, 1);
    // And it is still in object storage, which is the whole argument.
    assert.equal(p.raw.size, 2);
  });
});

describe("the lateness window against the correction window", () => {
  const wide = run(7 * DAY);
  const atDeadline = run(DEFAULT_CONFIG.correctionWindowMs);
  const narrow = run(6 * HOUR);

  it("loses nothing once the window reaches the correction deadline", () => {
    assert.equal(atDeadline.tally.droppedLate, 0);
    assert.equal(atDeadline.digest(), wide.digest());
  });

  it("loses evidence when the window is shorter than the correction deadline", () => {
    assert.ok(narrow.tally.droppedLate > 0, "expected dropped records");
    assert.ok(narrow.tally.entries < wide.tally.entries);
    assert.notEqual(narrow.digest(), wide.digest());
  });

  it("loses it without changing the case-state summary", () => {
    // The finding the module exists to produce. Twenty-seven pieces of
    // evidence are gone, the reported financial position has moved, and every
    // number an operator would put on a dashboard is unchanged.
    assert.deepEqual(states(narrow), states(wide));
  });

  it("and without unbalancing the ledger", () => {
    assert.equal(narrow.ledger.isBalanced(), true);
    assert.equal(wide.ledger.isBalanced(), true);
  });

  it("drops no more evidence as the window widens", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const ms of [HOUR, 6 * HOUR, DAY, 2 * DAY, 5 * DAY, 7 * DAY]) {
      const dropped = run(ms).tally.droppedLate;
      assert.ok(dropped <= previous, `widening to ${ms} increased drops`);
      previous = dropped;
    }
    assert.equal(previous, 0);
  });

  it("recovers exactly by re-reading the raw objects with a wider window", () => {
    const recovered = new Pipeline({ allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG });
    recovered.ingest(narrow.raw.all().map((o) => o.record));
    recovered.close(T0 + 60 * DAY);
    assert.equal(recovered.tally.droppedLate, 0);
    assert.equal(recovered.digest(), wide.digest());
  });
});
