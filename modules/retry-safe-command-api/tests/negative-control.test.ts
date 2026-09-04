import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DeterministicProvider, Fault, ProviderTimeoutError } from "../src/provider.ts";
import { InMemoryTransactionalStore, BUSINESS_REFERENCE_INDEX, TABLES } from "../src/store.ts";
import { auditEffects } from "../src/invariants.ts";
import { createLab } from "../src/app.ts";
import { deterministicClock } from "../src/clock.ts";
import { writeResult } from "./helpers.ts";

/**
 * A test harness that never fails proves nothing. These are the negative
 * controls: deliberately broken implementations that the harness must catch.
 * If any of these stop failing, the harness has stopped measuring anything.
 */
describe("negative controls: the harness must detect real double-charge bugs", () => {
  test("N1: a fresh idempotency key per retry produces one effect per attempt", async () => {
    const provider = new DeterministicProvider();
    const store = new InMemoryTransactionalStore([BUSINESS_REFERENCE_INDEX]);

    // The classic bug: the key is generated inside the retry loop, so every
    // attempt looks like new business intent to the provider.
    const attempts = 100;
    for (let i = 0; i < attempts; i++) {
      await provider.charge({ idempotencyKey: randomUUID(), amountMinor: 4999, currency: "USD" });
    }

    const audit = auditEffects(store, provider);
    assert.equal(audit.providerEffects, attempts, "the provider really did charge 100 times");
    assert.ok(
      audit.violations.length > 0,
      "the harness must report unattributed money movement",
    );
    assert.match(audit.violations[0], /cannot be attributed/);
    writeResult("n1-fresh-key-per-retry", {
      providerEffects: audit.providerEffects,
      violationCount: audit.violations.length,
      sampleViolation: audit.violations[0],
    });
  });

  test("N2: a service that ignores unknown outcomes and retries blind double-charges", async () => {
    const provider = new DeterministicProvider([Fault.DROP_RESPONSE_AFTER_EFFECT]);
    const store = new InMemoryTransactionalStore([BUSINESS_REFERENCE_INDEX]);
    const key = "stable-key-but-no-state";

    // First call: the effect lands, the response is lost.
    await assert.rejects(
      () => provider.charge({ idempotencyKey: key, amountMinor: 4999, currency: "USD" }),
      ProviderTimeoutError,
    );
    assert.equal(provider.effectCount(), 1);

    // Retrying with the SAME key is safe here only because this provider
    // honours idempotency keys. That is a provider property, not ours.
    const retry = await provider.charge({ idempotencyKey: key, amountMinor: 4999, currency: "USD" });
    assert.equal(retry.replayed, true);
    assert.equal(provider.effectCount(), 1, "the provider absorbed the duplicate");

    const audit = auditEffects(store, provider);
    assert.ok(audit.violations.length > 0, "but the caller has no record of the effect at all");
    writeResult("n2-blind-retry-relies-on-provider", {
      providerEffects: audit.providerEffects,
      violations: audit.violations,
    });
  });

  test("N3: a consumer without an inbox posts the ledger entry twice on redelivery", async () => {
    const lab = createLab({ clock: deterministicClock() });
    await lab.service.execute({
      operationId: "op_no_inbox",
      operationType: "CHARGE",
      businessReference: "order-n3",
      amountMinor: 2500,
      currency: "USD",
    });
    await lab.deliver();
    assert.equal(lab.audit().ledgerPostings, 1);

    // Simulate a consumer that skipped the inbox check: post directly again
    // under a different surrogate key, as a message-id-keyed consumer would.
    await lab.store.runTransaction((tx) => {
      tx.write(TABLES.LEDGER, "eff_duplicate_surrogate", {
        effectId: "eff_duplicate_surrogate",
        operationId: "op_no_inbox",
        businessReference: "order-n3",
        amountMinor: 2500,
        currency: "USD",
        direction: "DEBIT",
        postedAtMs: lab.clock.nowMs(),
      });
    });

    const audit = lab.audit();
    assert.equal(audit.ledgerPostings, 2);
    assert.ok(
      audit.violations.some((v) => /posted 2 ledger entries for 1 provider effects/.test(v)),
      `expected a ledger-vs-provider mismatch, got: ${JSON.stringify(audit.violations)}`,
    );
    writeResult("n3-consumer-without-inbox", {
      ledgerPostings: audit.ledgerPostings,
      providerEffects: audit.providerEffects,
      violations: audit.violations,
    });
  });

  test("N4: a provider that does not honour idempotency keys is detected, not assumed away", async () => {
    const provider = new DeterministicProvider();
    const store = new InMemoryTransactionalStore([BUSINESS_REFERENCE_INDEX]);
    // Same logical operation, but the provider namespaces each call itself.
    for (let i = 0; i < 3; i++) {
      await provider.charge({
        idempotencyKey: `provider-ignores-this-${i}`,
        amountMinor: 1000,
        currency: "USD",
      });
    }
    const audit = auditEffects(store, provider);
    assert.equal(audit.providerEffects, 3);
    assert.equal(audit.providerAmountMinor, 3000);
    assert.ok(audit.violations.length >= 3);
    writeResult("n4-non-idempotent-provider", {
      providerEffects: audit.providerEffects,
      providerAmountMinor: audit.providerAmountMinor,
      violationCount: audit.violations.length,
    });
  });
});
