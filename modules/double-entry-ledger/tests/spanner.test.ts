// The four Spanner behaviours a ledger has to survive, plus the privilege
// boundary that makes a posting immutable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccessDenied,
  MUTATION_LIMIT,
  MutationLimitExceeded,
  SpannerModel,
  appendOnlyRole,
  parentOnlyRole,
  readerRole,
  type Principal,
} from "../src/spanner.ts";

const writer: Principal = { kind: "FGAC", id: "ledger-service", role: appendOnlyRole() };

test("S01 a read-write transaction body runs again after an abort", () => {
  const db = new SpannerModel();
  let bodyRuns = 0;
  const { stats } = db.runReadWrite(writer, { tick: 1, abortsBeforeCommit: 2 }, (txn) => {
    bodyRuns += 1;
    txn.insert("Journals", "k", { journalId: "k", ledgerId: "l" });
    return bodyRuns;
  });
  // The documented behaviour: "Spanner might execute a transaction's
  // operations multiple times internally."
  assert.equal(bodyRuns, 3);
  assert.equal(stats.attempts, 3);
  // And only one row, because the mutations of the discarded attempts never
  // reached the database.
  assert.equal(db.table("Journals").size, 1);
});

test("S02 a side effect in the body happens once per attempt, not once per commit", () => {
  const db = new SpannerModel();
  const externalCalls: number[] = [];
  db.runReadWrite(writer, { tick: 2, abortsBeforeCommit: 2 }, (txn) => {
    // Anything that is not a buffered mutation is outside the atomic unit.
    externalCalls.push(externalCalls.length + 1);
    txn.insert("Journals", "k", { journalId: "k" });
    return null;
  });
  assert.equal(externalCalls.length, 3);
  assert.equal(db.table("Journals").size, 1);
});

test("S03 a deterministic key survives the retry; a minted one does not", () => {
  const db = new SpannerModel();
  let counter = 0;
  db.runReadWrite(writer, { tick: 3, abortsBeforeCommit: 2 }, (txn) => {
    counter += 1;
    // Derived from content: the same key on every attempt.
    txn.insert("Postings", "ldg/acct/pst_derived", { n: counter });
    return null;
  });
  assert.equal(db.table("Postings").size, 1);

  // Now the other way round. Each attempt commits separately here, which is
  // what makes the point visible: identity minted per attempt is identity of
  // the attempt, not of the operation.
  let minted = 0;
  for (const tick of [4, 5, 6]) {
    minted += 1;
    db.runReadWrite(writer, { tick }, (txn) => {
      txn.insert("Postings", `ldg/acct/pst_minted_${minted}`, { n: minted });
      return null;
    });
  }
  assert.equal(db.table("Postings").size, 4);
});

test("S04 mutations are buffered and invisible until the commit", () => {
  const db = new SpannerModel();
  db.runReadWrite(writer, { tick: 7 }, (txn) => {
    txn.insert("Journals", "buffered", { journalId: "buffered" });
    // Documented: "if you use mutations, changes are buffered locally and are
    // only visible after the transaction commits."
    assert.equal(txn.read("Journals", "buffered"), null);
    return null;
  });
  assert.notEqual(db.rowAt("Journals", "buffered"), null);
});

test("S05 two transactions can share a commit timestamp when their writes do not overlap", () => {
  const db = new SpannerModel();
  const a = db.runReadWrite(writer, { tick: 8 }, (txn) => {
    txn.insert("Postings", "ldg/acct-a/p1", { accountId: "acct-a" });
    return null;
  });
  const b = db.runReadWrite(writer, { tick: 8 }, (txn) => {
    txn.insert("Postings", "ldg/acct-b/p1", { accountId: "acct-b" });
    return null;
  });
  // "Commit timestamp values are not guaranteed to be unique. Transactions
  // that write to non-overlapping sets of fields might have the same
  // timestamp." So a commit timestamp alone is not a journal sequence number.
  assert.equal(a.stats.commitTimestamp, b.stats.commitTimestamp);
});

test("S06 two transactions writing the same field cannot share a timestamp", () => {
  const db = new SpannerModel();
  db.runReadWrite(writer, { tick: 9 }, (txn) => {
    txn.insert("Postings", "ldg/acct-a/p1", { v: 1 });
    return null;
  });
  assert.throws(
    () =>
      db.runReadWrite(writer, { tick: 9 }, (txn) => {
        txn.insert("Postings", "ldg/acct-a/p1", { v: 2 });
        return null;
      }),
    /distinct commit timestamps/,
  );
});

test("S07 mutations are counted per column, so a wide posting costs more than one", () => {
  const db = new SpannerModel();
  const { stats } = db.runReadWrite(writer, { tick: 10 }, (txn) => {
    txn.insert("Postings", "k1", { a: 1, b: 2, c: 3, d: 4, e: 5 });
    txn.insert("Postings", "k2", { a: 1, b: 2, c: 3, d: 4, e: 5 });
    return null;
  });
  // Two rows, ten mutations. "Insert and update operations count with the
  // multiplicity of the number of columns they affect."
  assert.equal(stats.mutationCount, 10);
});

test("S08 a journal too large for one commit is refused rather than split", () => {
  const db = new SpannerModel();
  const columns = 8;
  const rows = Math.ceil(MUTATION_LIMIT / columns) + 1;
  assert.throws(
    () =>
      db.runReadWrite(writer, { tick: 11 }, (txn) => {
        for (let i = 0; i < rows; i += 1) {
          txn.insert("Postings", `k${i}`, {
            a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8,
          });
        }
        return null;
      }),
    MutationLimitExceeded,
  );
});

test("S09 the append-only role cannot update or delete a posting", () => {
  const db = new SpannerModel();
  db.runReadWrite(writer, { tick: 12 }, (txn) => {
    txn.insert("Postings", "p", { v: 1 });
    return null;
  });
  assert.throws(
    () => db.runReadWrite(writer, { tick: 13 }, (txn) => txn.update("Postings", "p", { v: 2 })),
    AccessDenied,
  );
  assert.throws(
    () => db.runReadWrite(writer, { tick: 14 }, (txn) => txn.delete("Postings", "p")),
    AccessDenied,
  );
  assert.deepEqual(db.rowAt("Postings", "p"), { v: 1 });
});

test("S10 a grant on the parent table does not reach the interleaved child", () => {
  const db = new SpannerModel();
  const parentOnly: Principal = { kind: "FGAC", id: "reporting", role: parentOnlyRole() };
  db.runReadWrite(writer, { tick: 15 }, (txn) => {
    txn.insert("Journals", "j", { journalId: "j" });
    txn.insert("Postings", "j/p", { postingId: "p" });
    return null;
  });
  // Reading the journal is fine.
  db.runReadWrite(parentOnly, { tick: 16 }, (txn) => {
    assert.notEqual(txn.read("Journals", "j"), null);
    return null;
  });
  // Reading its postings is not. "For interleaved tables, a privilege granted
  // on the parent table doesn't propagate to the child table."
  assert.throws(
    () => db.runReadWrite(parentOnly, { tick: 17 }, (txn) => txn.read("Postings", "j/p")),
    AccessDenied,
  );
});

test("S11 a reader role cannot write, and an unlisted table is denied outright", () => {
  const db = new SpannerModel();
  const reader: Principal = { kind: "FGAC", id: "analyst", role: readerRole() };
  assert.throws(
    () => db.runReadWrite(reader, { tick: 18 }, (txn) => txn.insert("Postings", "x", { v: 1 })),
    AccessDenied,
  );
  assert.throws(
    () => db.runReadWrite(reader, { tick: 19 }, (txn) => txn.read("AccountBalances", "x")),
    AccessDenied,
  );
});

test("S12 database-level IAM is not filtered by the database role", () => {
  const db = new SpannerModel();
  db.runReadWrite(writer, { tick: 20 }, (txn) => {
    txn.insert("Postings", "p", { v: 1 });
    return null;
  });
  // The documented advice is to revoke database-level roles once fine-grained
  // roles are in place, "so that the principal's access control is managed by
  // only one method". This is what happens if you do not.
  const admin: Principal = { kind: "DATABASE_IAM", id: "migration-runner", iamRole: "databaseUser" };
  db.runReadWrite(admin, { tick: 21 }, (txn) => {
    txn.delete("Postings", "p");
    return null;
  });
  assert.equal(db.rowAt("Postings", "p"), null);
});

test("S13 the change stream reports writes the application did not make", () => {
  const db = new SpannerModel();
  db.watchTable("Postings");
  db.runReadWrite(writer, { tick: 22 }, (txn) => {
    txn.insert("Postings", "p1", { v: 1 });
    txn.insert("Postings", "p2", { v: 2 });
    txn.insert("Journals", "j", { v: 3 });
    return null;
  });
  const stream = db.changeStream();
  assert.equal(stream.length, 2);
  assert.equal(stream[0]?.numberOfRecordsInTransaction, 2);
  assert.equal(stream[0]?.serverTransactionId, stream[1]?.serverTransactionId);
  // The unwatched table produced nothing.
  assert.equal(stream.filter((r) => r.table === "Journals").length, 0);
});
