// Replay, and the invariant it has to satisfy:
//
//   Replaying the same evidence may repeat computation, but it must not
//   silently create an additional accepted financial effect, and every
//   adjustment must remain traceable to source evidence.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Pipeline } from "../src/pipeline.ts";
import { DEFAULT_CONFIG } from "../src/reconcile.ts";
import { DEFAULT_STREAM, generate } from "../src/stream.ts";

const T0 = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;

function loaded(weaknesses = {}): Pipeline {
  const p = new Pipeline({
    allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG, weaknesses,
  });
  p.ingest(generate({ ...DEFAULT_STREAM, transactions: 120 }, T0).records);
  p.close(T0 + 60 * DAY);
  return p;
}

describe("replay", () => {
  it("repeats the computation", () => {
    const p = loaded();
    const before = p.tally.computations;
    p.replay();
    assert.ok(p.tally.computations > before);
  });

  it("does not create an additional accepted financial effect", () => {
    const p = loaded();
    const before = p.tally.entries;
    p.replay();
    p.replay();
    p.replay();
    assert.equal(p.tally.entries, before);
  });

  it("leaves the result digest unchanged", () => {
    const p = loaded();
    const before = p.digest();
    p.replay();
    p.close(T0 + 60 * DAY);
    assert.equal(p.digest(), before);
  });

  it("survives every derived store being thrown away and rebuilt", () => {
    const p = loaded();
    const before = { entries: p.tally.entries, digest: p.digest() };
    p.rebuildDerived();
    assert.equal(p.reconciler.cases.size, 0);
    p.replay();
    p.close(T0 + 60 * DAY);
    assert.equal(p.tally.entries, before.entries);
    assert.equal(p.digest(), before.digest);
    assert.equal(p.ledger.isBalanced(), true);
  });

  it("doubles the accepted effects once the ledger's entry id guard is removed", () => {
    // The negative control for the only mechanism that is load-bearing after
    // a rebuild. Without it, a recovery run charges the business twice and the
    // ledger still balances.
    const p = loaded({ noEntryDedup: true });
    const before = p.tally.entries;
    p.rebuildDerived();
    p.replay();
    assert.equal(p.tally.entries, before * 2);
    assert.equal(p.ledger.isBalanced(), true);
  });

  it("produces the same result from two independent pipelines over the same evidence", () => {
    const a = loaded();
    const b = loaded();
    assert.equal(a.digest(), b.digest());
    assert.equal(a.tally.entries, b.tally.entries);
  });
});

describe("immutable raw evidence", () => {
  it("refuses to overwrite an object and keeps the first body", () => {
    const p = new Pipeline({ allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG });
    const body = { kind: "CAPTURED", ref: "t1", currency: "EUR", occurredAtMs: T0, grossMinor: 100 };
    p.ingest([{ sourceEventId: "a", source: "gateway", receivedAtMs: T0, body }]);
    p.ingest([{
      sourceEventId: "a", source: "gateway", receivedAtMs: T0 + 1,
      body: { ...body, grossMinor: 999_999 },
    }]);
    const stored = p.raw.get("gateway/a")!;
    assert.equal((stored.record.body as Record<string, unknown>)["grossMinor"], 100);
    assert.equal(stored.generation, 1);
    assert.equal(p.raw.size, 1);
    const reasons = [...p.reconciler.cases.values()].flatMap((c) => c.exceptions.map((x) => x.reason));
    assert.ok(reasons.includes("RAW_IMMUTABLE_CONFLICT"));
  });

  it("counts a byte-identical redelivery without raising anything", () => {
    const p = new Pipeline({ allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG });
    const record = {
      sourceEventId: "a", source: "gateway" as const, receivedAtMs: T0,
      body: { kind: "CAPTURED", ref: "t1", currency: "EUR", occurredAtMs: T0, grossMinor: 100 },
    };
    p.ingest([record, record, record]);
    assert.equal(p.raw.refusedDeliveries, 2);
    assert.equal(p.tally.entries, 1);
    assert.deepEqual([...p.reconciler.cases.values()].flatMap((c) => c.exceptions), []);
  });

  it("offers no way to delete or amend stored evidence", () => {
    const p = new Pipeline({ allowedLatenessMs: 7 * DAY, reconcile: DEFAULT_CONFIG });
    const store = p.raw as unknown as Record<string, unknown>;
    for (const name of ["delete", "remove", "update", "overwrite", "truncate"]) {
      assert.equal(typeof store[name], "undefined", `raw store exposes ${name}`);
    }
  });
});

describe("every accepted effect names its evidence", () => {
  it("holds across a full stream", () => {
    const p = loaded();
    for (const entry of p.ledger.all()) {
      assert.ok(entry.evidenceId.length > 0, `${entry.purpose} has no evidence`);
      assert.ok(entry.transactionId.length > 0);
    }
  });
});
