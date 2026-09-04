import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  SpannerError,
  SpannerSession,
  emulatorReachable,
  targetFromEnv,
  type Mutation,
} from "../src/spanner-rest.ts";
import { writeResult } from "./helpers.ts";

/**
 * These tests check the schema against the real Spanner engine.
 *
 * The conformance suite proves the service logic. This proves that the two
 * schema properties the design leans on are properties of Spanner and not of
 * my in-memory approximation:
 *
 *   1. a UNIQUE index is enforced at commit time, so a second charge for the
 *      same order fails the transaction rather than racing through;
 *   2. a generated column that becomes NULL removes the row from a
 *      NULL_FILTERED index, which is how a declined attempt releases the order.
 *
 * Skipped automatically when the emulator is not running.
 */
const target = targetFromEnv();
let available = false;
let session: SpannerSession;

const OP_COLUMNS = [
  "operation_id", "operation_type", "business_reference", "request_fingerprint",
  "amount_minor", "currency", "state", "provider_operation_key",
  "attempt_count", "reconcile_attempts", "created_at", "updated_at",
];

function opRow(id: string, businessRef: string, state: string): unknown[] {
  return [
    id, "CHARGE", businessRef, "f".repeat(64),
    "4999", "USD", state, `pk_${id}`,
    "1", "0", "spanner.commit_timestamp()", "spanner.commit_timestamp()",
  ];
}

function insertOp(id: string, businessRef: string, state = "IN_PROGRESS"): Mutation {
  return { insert: { table: "payment_operations", columns: OP_COLUMNS, values: [opRow(id, businessRef, state)] } };
}

before(async () => {
  available = await emulatorReachable(target);
  if (!available) return;
  session = new SpannerSession(target);
  await session.open();
  await session.writeAtomically([
    { delete: { table: "payment_operations", keySet: { all: true } } },
    { delete: { table: "effect_claims", keySet: { all: true } } },
  ]);
});

after(async () => {
  if (available && session) await session.close();
});

describe("Spanner schema semantics (emulator)", () => {
  test("S1: the UNIQUE index refuses a second live operation for one order", async (t) => {
    if (!available) return t.skip("Spanner emulator not reachable");

    await session.writeAtomically([insertOp("s1_first", "order-s1")]);

    let rejected: SpannerError | null = null;
    try {
      await session.writeAtomically([insertOp("s1_second", "order-s1")], 1);
    } catch (err) {
      rejected = err as SpannerError;
    }
    // The property under test is that the commit fails and only one row
    // survives. The emulator's error text for this case is unhelpful
    // ("failed to marshal error message"), which is consistent with the
    // documented statement that error messages can differ from production, so
    // the assertion is on the observable state rather than on the wording.
    assert.ok(rejected, "Spanner must reject the second operation");
    const rows = await session.query(
      "SELECT operation_id FROM payment_operations WHERE business_reference = 'order-s1'",
    );
    assert.equal(rows.length, 1, "exactly one live operation for the order");
    writeResult("s1-unique-index-enforced", {
      engine: "cloud-spanner-emulator",
      rejectedCode: rejected?.code,
      rejectedMessage: rejected?.message,
      note: "Emulator error text differs from production; the assertion is on committed state.",
      liveOperations: rows.length,
    });
  });

  test("S2: a FAILED_FINAL operation releases the order via the NULL_FILTERED index", async (t) => {
    if (!available) return t.skip("Spanner emulator not reachable");

    await session.writeAtomically([insertOp("s2_declined", "order-s2")]);

    // Second attempt is refused while the first is live.
    await assert.rejects(() => session.writeAtomically([insertOp("s2_retry", "order-s2")], 1));

    // The first attempt is definitively declined: no money moved.
    await session.writeAtomically([
      {
        update: {
          table: "payment_operations",
          columns: ["operation_id", "state", "updated_at"],
          values: [["s2_declined", "FAILED_FINAL", "spanner.commit_timestamp()"]],
        },
      },
    ]);

    const generated = await session.query(
      "SELECT active_business_reference FROM payment_operations WHERE operation_id = 's2_declined'",
    );
    assert.deepEqual(generated[0], [null], "the generated column is NULL once FAILED_FINAL");

    // Now the same order can be attempted again under a new operation id.
    await session.writeAtomically([insertOp("s2_retry", "order-s2")]);
    const rows = await session.query(
      "SELECT operation_id, state FROM payment_operations WHERE business_reference = 'order-s2' ORDER BY operation_id",
    );
    assert.equal(rows.length, 2);
    writeResult("s2-null-filtered-release", {
      engine: "cloud-spanner-emulator",
      generatedColumnAfterDecline: generated[0],
      rows,
    });
  });

  test("S3: expires_at stays NULL for an unresolved outcome, so TTL cannot delete it", async (t) => {
    if (!available) return t.skip("Spanner emulator not reachable");

    await session.writeAtomically([insertOp("s3_unknown", "order-s3", "OUTCOME_UNKNOWN")]);
    const rows = await session.query(
      "SELECT state, expires_at FROM payment_operations WHERE operation_id = 's3_unknown'",
    );
    assert.equal(rows[0]?.[0], "OUTCOME_UNKNOWN");
    assert.equal(rows[0]?.[1], null, "expires_at must be NULL while the outcome is unknown");
    writeResult("s3-ttl-null-guard", {
      engine: "cloud-spanner-emulator",
      note: "Spanner's row deletion policy does not delete rows whose timestamp column is NULL.",
      row: rows[0],
    });
  });

  test("S4: concurrent read-modify-write serializes, with no lost update", async (t) => {
    if (!available) return t.skip("Spanner emulator not reachable");

    await session.writeAtomically([insertOp("s4_row", "order-s4")]);

    const bump = async (worker: string): Promise<string> => {
      const local = new SpannerSession(target);
      await local.open();
      try {
        for (let attempt = 1; attempt <= 25; attempt++) {
          const txn = await local.beginReadWrite();
          try {
            const rows = await local.queryInTransaction(
              txn,
              "SELECT attempt_count FROM payment_operations WHERE operation_id = 's4_row'",
            );
            const current = Number(rows[0]?.[0] ?? "0");
            await new Promise((r) => setTimeout(r, 5));
            await local.commit(txn, [
              {
                update: {
                  table: "payment_operations",
                  columns: ["operation_id", "attempt_count", "updated_at"],
                  values: [["s4_row", String(current + 1), "spanner.commit_timestamp()"]],
                },
              },
            ]);
            return `${worker}:committed:attempt${attempt}`;
          } catch (err) {
            if (err instanceof SpannerError && err.code === "ABORTED") {
              // Exponential backoff with jitter. Retrying an ABORTED
              // transaction immediately just re-enters the same contention.
              const backoff = Math.min(2 ** attempt, 64) + Math.random() * 10;
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            throw err;
          }
        }
        throw new Error(`${worker} exhausted retries`);
      } finally {
        await local.close();
      }
    };

    // The emulator locks the whole database for a read-write transaction, so
    // this exercises the ABORTED-and-retry path rather than true concurrency.
    // Production Spanner would interleave these; the outcome under test - no
    // lost update - is the same either way.
    const outcomes = await Promise.all([bump("w1"), bump("w2"), bump("w3")]);
    const rows = await session.query(
      "SELECT attempt_count FROM payment_operations WHERE operation_id = 's4_row'",
    );
    assert.equal(Number(rows[0]?.[0]), 4, "1 initial + 3 increments, no lost update");
    writeResult("s4-serializable-no-lost-update", {
      engine: "cloud-spanner-emulator",
      finalAttemptCount: Number(rows[0]?.[0]),
      outcomes,
      emulatorNote:
        "Read-write transactions and schema changes lock the entire database for exclusive access until completion (documented emulator difference).",
    });
  });
});
