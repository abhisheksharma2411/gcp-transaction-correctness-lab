import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLab } from "../src/app.ts";
import { Fault } from "../src/provider.ts";
import { OperationState, ResultStatus, type PaymentCommand } from "../src/types.ts";
import { assertNoViolations } from "../src/invariants.ts";
import { DAY_MS, MINUTE_MS, deterministicClock } from "../src/clock.ts";
import { InMemoryTransactionalStore, BUSINESS_REFERENCE_INDEX, TABLES } from "../src/store.ts";
import { writeResult } from "./helpers.ts";

function charge(overrides: Partial<PaymentCommand> = {}): PaymentCommand {
  return {
    operationId: "op_checkout_1001",
    operationType: "CHARGE",
    businessReference: "order-1001",
    amountMinor: 4999,
    currency: "USD",
    ...overrides,
  };
}

describe("retry-safe command API business-effect conformance", () => {
  test("T1: 100 sequential retries of one operation id converge on one effect", async () => {
    const lab = createLab();
    const cmd = charge();
    const results = [];
    for (let i = 0; i < 100; i++) results.push(await lab.service.execute(cmd));
    await lab.deliver();

    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1, "exactly one money-moving effect");
    assert.equal(audit.ledgerPostings, 1, "exactly one ledger posting");
    assert.equal(audit.providerCalls, 1, "the provider is called once, not 100 times");
    assert.equal(results.filter((r) => r.status === ResultStatus.ACCEPTED).length, 100);
    assert.equal(results.filter((r) => r.replayed).length, 99, "99 answers are replays");
    writeResult("t1-duplicate-100", { audit, distinctStatuses: [...new Set(results.map((r) => r.status))] });
  });

  test("T2: concurrent first requests do not create two effects", async () => {
    const lab = createLab();
    const cmd = charge({ operationId: "op_concurrent", businessReference: "order-2002" });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => lab.service.withWorker(`worker-${i}`).execute(cmd)),
    );
    await lab.deliver();

    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1);
    assert.equal(audit.ledgerPostings, 1);
    const accepted = results.filter((r) => r.status === ResultStatus.ACCEPTED);
    const rejected = results.filter((r) => r.status === ResultStatus.IN_PROGRESS_ELSEWHERE);
    assert.ok(accepted.length >= 1, "at least one caller gets the answer");
    assert.equal(accepted.length + rejected.length, 8, "every caller gets a defined answer");
    writeResult("t2-concurrent", {
      audit,
      accepted: accepted.length,
      inProgressElsewhere: rejected.length,
      storeAborts: lab.store.stats.aborts,
    });
  });

  test("T3a: same operation id with a different amount is rejected, not replayed", async () => {
    const lab = createLab();
    const first = await lab.service.execute(charge({ operationId: "op_mismatch" }));
    assert.equal(first.status, ResultStatus.ACCEPTED);

    const second = await lab.service.execute(
      charge({ operationId: "op_mismatch", amountMinor: 9999 }),
    );
    assert.equal(second.status, ResultStatus.PARAMETER_MISMATCH);
    assert.equal(second.httpStatus, 422);

    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1, "the mismatched retry never reached the provider");
    assert.equal(audit.providerCalls, 1);
    writeResult("t3a-parameter-mismatch", { audit, second });
  });

  test("T3b: a different operation id for the same business reference is refused", async () => {
    const lab = createLab();
    await lab.service.execute(charge({ operationId: "op_first", businessReference: "order-3003" }));
    const second = await lab.service.execute(
      charge({ operationId: "op_second_fresh_uuid", businessReference: "order-3003" }),
    );
    assert.equal(second.status, ResultStatus.BUSINESS_REFERENCE_CONFLICT);

    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1, "a fresh key per retry must not buy a second charge");
    writeResult("t3b-business-reference-conflict", { audit, second });
  });

  test("T4: provider succeeds, response is lost, reconciliation recovers the truth", async () => {
    const lab = createLab({ faults: [Fault.DROP_RESPONSE_AFTER_EFFECT] });
    const cmd = charge({ operationId: "op_lost_response", businessReference: "order-4004" });

    const first = await lab.service.execute(cmd);
    assert.equal(first.status, ResultStatus.PENDING_UNKNOWN);
    assert.equal(first.state, OperationState.OUTCOME_UNKNOWN);

    // A client retry while the outcome is unknown must not charge again.
    const retry = await lab.service.execute(cmd);
    assert.equal(retry.status, ResultStatus.PENDING_UNKNOWN);
    assert.equal(lab.provider.effectCount(), 1, "still exactly one effect");

    const [reconciled] = await lab.service.runReconciliation();
    assert.equal(reconciled.status, ResultStatus.ACCEPTED);
    assert.equal(reconciled.state, OperationState.SUCCEEDED);

    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1);
    assert.equal(audit.ledgerPostings, 1, "the recovered success still reaches accounting");
    assert.equal(audit.providerLookups, 1);
    writeResult("t4-lost-response-reconciled", { audit, first, retry, reconciled });
  });

  test("T5: a restart does not erase the operation decision", async () => {
    const clock = deterministicClock();
    const store = new InMemoryTransactionalStore([BUSINESS_REFERENCE_INDEX]);
    let lab = createLab({ store, clock, faults: [Fault.DROP_RESPONSE_AFTER_EFFECT] });
    const cmd = charge({ operationId: "op_restart", businessReference: "order-5005" });

    const before = await lab.service.execute(cmd);
    assert.equal(before.state, OperationState.OUTCOME_UNKNOWN);

    // Restart: in-process reconcile queue is gone, durable state is not.
    lab = lab.restart();
    assert.equal(lab.service.reconcileQueue.size, 0, "the queue was in memory and is lost");

    const after = await lab.service.execute(cmd);
    assert.equal(after.status, ResultStatus.PENDING_UNKNOWN, "the decision survived the restart");
    assert.equal(lab.provider.effectCount(), 1, "the restart did not buy a second charge");

    const [reconciled] = await lab.service.runReconciliation();
    assert.equal(reconciled.status, ResultStatus.ACCEPTED);
    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1);
    assert.equal(audit.ledgerPostings, 1);
    writeResult("t5-restart", { audit, before, after, reconciled });
  });

  test("T6: event redelivery and publish-side duplicates do not double-post", async () => {
    const lab = createLab();
    await lab.service.execute(charge({ operationId: "op_redeliver", businessReference: "order-6006" }));
    await lab.deliver();
    assert.equal(lab.audit().ledgerPostings, 1);

    await lab.consumer.handleAll(lab.bus.redeliverAll());
    await lab.consumer.handleAll(lab.bus.redeliverAll());
    await lab.consumer.handleAll(lab.bus.duplicatePublishSide());

    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.ledgerPostings, 1, "still one posting after redelivery and publish duplicates");
    assert.ok(lab.consumer.skippedDuplicateCount >= 3);
    writeResult("t6-redelivery", {
      audit,
      handled: lab.consumer.handledCount,
      skippedDuplicates: lab.consumer.skippedDuplicateCount,
    });
  });

  test("T7: reconciliation is idempotent", async () => {
    const lab = createLab({ faults: [Fault.DROP_RESPONSE_AFTER_EFFECT] });
    const cmd = charge({ operationId: "op_recon_idem", businessReference: "order-7007" });
    await lab.service.execute(cmd);

    const first = await lab.service.reconcile(cmd.operationId);
    const second = await lab.service.reconcile(cmd.operationId);
    const third = await lab.service.reconcile(cmd.operationId);
    assert.equal(first.status, ResultStatus.ACCEPTED);
    assert.equal(second.status, ResultStatus.ACCEPTED);
    assert.equal(second.replayed, true);
    assert.equal(third.replayed, true);

    await lab.deliver();
    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1);
    assert.equal(audit.ledgerPostings, 1);
    writeResult("t7-reconcile-idempotent", { audit, first, second, third });
  });

  test("T8: an expired operation identity does not become a second charge", async () => {
    const clock = deterministicClock();
    const lab = createLab({ clock, config: { identityRetentionMs: DAY_MS } });
    const cmd = charge({ operationId: "op_expiring", businessReference: "order-8008" });

    const first = await lab.service.execute(cmd);
    assert.equal(first.status, ResultStatus.ACCEPTED);
    await lab.deliver();

    clock.advance(DAY_MS + MINUTE_MS);
    const pruned = await lab.service.pruneExpiredIdentities();
    assert.equal(pruned, 1, "the idempotency record is gone");
    assert.equal(await lab.service.getOperation(cmd.operationId), null);

    const late = await lab.service.execute(cmd);
    assert.equal(late.status, ResultStatus.IDENTITY_EXPIRED);
    assert.equal(late.httpStatus, 409);
    assert.notEqual(late.providerEffectId, null, "the answer still points at the real effect");

    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1, "the late retry did not charge again");
    assert.equal(audit.providerCalls, 1);
    writeResult("t8-expired-identity", { audit, first, late, pruned });
  });

  test("T9: a definitive decline is final and frees the order for a new attempt", async () => {
    const lab = createLab({ faults: [Fault.DECLINE] });
    const declined = await lab.service.execute(
      charge({ operationId: "op_declined", businessReference: "order-9009" }),
    );
    assert.equal(declined.status, ResultStatus.DECLINED);
    assert.equal(declined.state, OperationState.FAILED_FINAL);

    const replay = await lab.service.execute(
      charge({ operationId: "op_declined", businessReference: "order-9009" }),
    );
    assert.equal(replay.status, ResultStatus.DECLINED);
    assert.equal(replay.replayed, true);

    // A new attempt on the same order needs a new operation identity.
    const retryWithNewIdentity = await lab.service.execute(
      charge({ operationId: "op_declined_retry_2", businessReference: "order-9009" }),
    );
    assert.equal(retryWithNewIdentity.status, ResultStatus.ACCEPTED);

    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1, "one effect for the successful second attempt only");
    writeResult("t9-decline-then-retry", { audit, declined, replay, retryWithNewIdentity });
  });

  test("T10: a refund carries its own operation identity", async () => {
    const lab = createLab();
    await lab.service.execute(charge({ operationId: "op_pay_10", businessReference: "order-1010" }));
    const refund = await lab.service.execute({
      operationId: "op_refund_10",
      operationType: "REFUND",
      businessReference: "order-1010",
      amountMinor: 4999,
      currency: "USD",
    });
    assert.equal(refund.status, ResultStatus.ACCEPTED, "the refund is not blocked by the charge claim");

    const refundReplay = await lab.service.execute({
      operationId: "op_refund_10",
      operationType: "REFUND",
      businessReference: "order-1010",
      amountMinor: 4999,
      currency: "USD",
    });
    assert.equal(refundReplay.replayed, true);
    assert.equal(lab.provider.effectCount(), 2, "one charge effect and one refund effect");
    writeResult("t10-refund-identity", { effects: lab.provider.allEffects() });
  });

  test("T11: an unknown outcome the provider cannot confirm escalates instead of guessing", async () => {
    const lab = createLab({
      faults: [Fault.TIMEOUT_BEFORE_EFFECT],
      config: { maxReconcileAttempts: 2 },
    });
    const cmd = charge({ operationId: "op_never_confirmed", businessReference: "order-1111" });
    const first = await lab.service.execute(cmd);
    assert.equal(first.status, ResultStatus.PENDING_UNKNOWN);

    let last = first;
    for (let i = 0; i < 4; i++) {
      const results = await lab.service.runReconciliation();
      if (results.length > 0) last = results[results.length - 1];
    }
    assert.equal(last.status, ResultStatus.NEEDS_MANUAL_REVIEW);
    assert.equal(last.state, OperationState.MANUAL_REVIEW);

    const audit = lab.audit({ allowManualReview: true });
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 0, "no money moved");
    assert.equal(audit.manualReviewOperations, 1, "the open question is visible, not hidden");
    writeResult("t11-manual-review", { audit, last });
  });

  test("T13: retention never prunes an unresolved operation, so a claim cannot be orphaned", async () => {
    const clock = deterministicClock();
    const lab = createLab({
      clock,
      faults: [Fault.DROP_RESPONSE_AFTER_EFFECT],
      config: { identityRetentionMs: DAY_MS },
    });
    const cmd = charge({ operationId: "op_unresolved", businessReference: "order-1313" });

    const first = await lab.service.execute(cmd);
    assert.equal(first.state, OperationState.OUTCOME_UNKNOWN);

    // Long past the retention window, with the outcome still unresolved.
    clock.advance(DAY_MS * 30);
    const pruned = await lab.service.pruneExpiredIdentities();
    assert.equal(pruned, 0, "an unresolved operation must never be pruned");

    const stillThere = await lab.service.getOperation(cmd.operationId);
    assert.equal(stillThere?.state, OperationState.OUTCOME_UNKNOWN);

    // The order is therefore never permanently blocked by an orphaned claim:
    // reconciliation can still resolve it, and resolution releases or confirms.
    const [reconciled] = await lab.service.runReconciliation();
    assert.equal(reconciled.status, ResultStatus.ACCEPTED);

    await lab.deliver();
    const audit = lab.audit();
    assertNoViolations(audit);
    assert.equal(audit.providerEffects, 1);
    writeResult("t13-unresolved-never-pruned", { audit, first, pruned, reconciled });
  });

  test("T12: the safety net fires if a code path forgets to take a claim", async () => {
    const lab = createLab();
    await lab.service.execute(charge({ operationId: "op_net_1", businessReference: "order-1212" }));

    // Write a rogue operation row directly, bypassing the claims table, the
    // way a future refactor might. The unique index must fail the commit.
    await assert.rejects(
      () =>
        lab.store.runTransaction((tx) => {
          tx.write(TABLES.OPERATIONS, "op_rogue", {
            operationId: "op_rogue",
            operationType: "CHARGE",
            businessReference: "order-1212",
            state: OperationState.IN_PROGRESS,
          });
        }),
      /unique index uq_operation_business_reference violated/,
    );

    const audit = lab.audit();
    assertNoViolations(audit);
    writeResult("t12-safety-net", { audit });
  });
});
