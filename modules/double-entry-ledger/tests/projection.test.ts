// The projection, and the three ways the transport can mislead it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BalanceProjection,
  completeTransactions,
  partitionRecords,
  partitionsOf,
} from "../src/projection.ts";
import { AS_OF, ACCOUNTS, buildScenario } from "../src/scenario.ts";
import { checkLedger } from "../src/invariants.ts";

test("P01 the projection rebuilt from the feed equals the sum of the postings", () => {
  const { ledger } = buildScenario();
  const projection = new BalanceProjection();
  projection.consumeAll(ledger.feed());
  for (const [accountId, authoritative] of ledger.rebuildBalances()) {
    assert.equal(projection.balanceOf(accountId), authoritative);
  }
});

test("P02 a redelivered partition does not apply twice", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  const projection = new BalanceProjection();
  projection.consumeAll(feed);
  const before = projection.snapshot();

  // A consumer crashed before checkpointing, so it re-reads from zero.
  for (const partition of partitionsOf(feed)) {
    projection.consumePartition(feed, partition, { from: 0 });
  }
  assert.deepEqual([...projection.snapshot().entries()].sort(), [...before.entries()].sort());
});

test("P03 without an inbox the same redelivery doubles a balance", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  const naive = new BalanceProjection({ dedupe: false });
  naive.consumeAll(feed);
  const first = partitionsOf(feed)[0];
  assert.ok(first !== undefined);
  naive.consumePartition(feed, first, { from: 0 });

  const authoritative = ledger.rebuildBalances();
  const drifted = [...authoritative.keys()].filter(
    (accountId) => naive.balanceOf(accountId) !== authoritative.get(accountId),
  );
  assert.ok(drifted.length > 0, "a projection with no inbox must drift on redelivery");
});

test("P04 a crash before the checkpoint replays the records it already applied", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  const partition = partitionsOf(feed)[0];
  assert.ok(partition !== undefined);
  const projection = new BalanceProjection();

  const run = projection.consumePartition(feed, partition, { crashAfter: 2 });
  assert.equal(run.applied, 2);
  // Nothing was checkpointed, so the next read starts where the last one did.
  assert.equal(projection.checkpointOf(partition), 1);

  const resumed = projection.consumePartition(feed, partition);
  assert.ok(resumed.skipped > 0, "the re-read must present records the inbox already knows");
  assert.equal(
    projection.appliedCount(),
    partitionRecords(feed, partition).length,
  );
});

test("P05 records for one journal are split across partitions", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  const byTransaction = new Map<string, Set<string>>();
  for (const record of feed) {
    const set = byTransaction.get(record.serverTransactionId) ?? new Set<string>();
    set.add(record.partition);
    byTransaction.set(record.serverTransactionId, set);
  }
  const split = [...byTransaction.values()].filter((partitions) => partitions.size > 1);
  assert.ok(
    split.length > 0,
    "at least one journal must land on more than one partition, or the test proves nothing",
  );
});

test("P06 reading one partition shows a journal that does not balance", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  const partition = partitionsOf(feed)[0];
  assert.ok(partition !== undefined);
  const seen = partitionRecords(feed, partition);
  const { partial } = completeTransactions(seen);
  assert.ok(
    partial.length > 0,
    "one partition must contain an incomplete transaction, or the ordering point is moot",
  );
  // Buffering by server transaction id until the expected count arrives is
  // what the numberOfRecordsInTransaction field is for.
  const whole = completeTransactions(feed);
  assert.equal(whole.partial.length, 0);
});

test("P07 within a partition records arrive in commit timestamp order", () => {
  const { ledger } = buildScenario();
  const feed = ledger.feed();
  for (const partition of partitionsOf(feed)) {
    const records = partitionRecords(feed, partition);
    for (let i = 1; i < records.length; i += 1) {
      const previous = records[i - 1];
      const current = records[i];
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(previous.commitTimestamp <= current.commitTimestamp);
    }
  }
});

test("P08 the projection carries no authority: deleting it changes no invariant but one", () => {
  const { ledger } = buildScenario();
  const empty = new BalanceProjection();
  const report = checkLedger(ledger, empty, AS_OF);
  const violated = report.invariants.filter((i) => i.status === "VIOLATED").map((i) => i.id);
  // Only the comparison breaks. Every accounting invariant is a statement
  // about the postings and survives the projection being thrown away.
  assert.deepEqual(violated, ["INV-3"]);
  void ACCOUNTS;
});
