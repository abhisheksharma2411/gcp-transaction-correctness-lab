#!/usr/bin/env node
/**
 * Failure-injection matrix.
 *
 * Runs each scenario end to end and reports the only numbers that matter:
 * how many requests were issued, how many times the provider was actually
 * called, how many money-moving effects exist, and how many ledger entries
 * were posted. Request counts are noise; effect counts are the result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLab } from "../src/app.ts";
import { Fault } from "../src/provider.ts";
import { deterministicClock, DAY_MS, MINUTE_MS } from "../src/clock.ts";
import { ResultStatus, type PaymentCommand } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "..", "results");

interface Row {
  scenario: string;
  fault: string;
  requestsIssued: number;
  providerCalls: number;
  providerLookups: number;
  providerEffects: number;
  ledgerPostings: number;
  openOperations: number;
  manualReview: number;
  storeAborts: number;
  violations: number;
  outcomes: Record<string, number>;
}

function cmd(overrides: Partial<PaymentCommand> = {}): PaymentCommand {
  return {
    operationId: "op_1",
    operationType: "CHARGE",
    businessReference: "order-1",
    amountMinor: 4999,
    currency: "USD",
    ...overrides,
  };
}

function tally(statuses: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

async function scenarioSequentialRetries(retries: number): Promise<Row> {
  const lab = createLab();
  const statuses: string[] = [];
  for (let i = 0; i < retries; i++) statuses.push((await lab.service.execute(cmd())).status);
  await lab.deliver();
  const a = lab.audit();
  return {
    scenario: `sequential retries x${retries}`,
    fault: "none",
    requestsIssued: retries,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(statuses),
  };
}

async function scenarioConcurrent(callers: number): Promise<Row> {
  const lab = createLab();
  const results = await Promise.all(
    Array.from({ length: callers }, (_, i) =>
      lab.service.withWorker(`w${i}`).execute(cmd({ operationId: "op_conc" })),
    ),
  );
  await lab.deliver();
  const a = lab.audit();
  return {
    scenario: `concurrent first requests x${callers}`,
    fault: "none",
    requestsIssued: callers,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(results.map((r) => r.status)),
  };
}

async function scenarioLostResponse(retries: number): Promise<Row> {
  const lab = createLab({ faults: [Fault.DROP_RESPONSE_AFTER_EFFECT] });
  const statuses: string[] = [];
  for (let i = 0; i < retries; i++) statuses.push((await lab.service.execute(cmd())).status);
  for (const r of await lab.service.runReconciliation()) statuses.push(r.status);
  await lab.deliver();
  const a = lab.audit();
  return {
    scenario: `provider succeeded, response lost, then ${retries} client retries`,
    fault: "DROP_RESPONSE_AFTER_EFFECT",
    requestsIssued: retries,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(statuses),
  };
}

async function scenarioTimeoutNoEffect(): Promise<Row> {
  const lab = createLab({
    faults: [Fault.TIMEOUT_BEFORE_EFFECT],
    config: { maxReconcileAttempts: 2 },
  });
  const statuses = [(await lab.service.execute(cmd())).status];
  for (let i = 0; i < 4; i++) {
    for (const r of await lab.service.runReconciliation()) statuses.push(r.status);
  }
  await lab.deliver();
  const a = lab.audit({ allowManualReview: true });
  return {
    scenario: "provider never received the request, reconciliation budget exhausted",
    fault: "TIMEOUT_BEFORE_EFFECT",
    requestsIssued: 1,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(statuses),
  };
}

async function scenarioRedelivery(rounds: number): Promise<Row> {
  const lab = createLab();
  const statuses = [(await lab.service.execute(cmd())).status];
  await lab.deliver();
  for (let i = 0; i < rounds; i++) await lab.consumer.handleAll(lab.bus.redeliverAll());
  await lab.consumer.handleAll(lab.bus.duplicatePublishSide());
  const a = lab.audit();
  return {
    scenario: `event redelivered ${rounds}x plus a publish-side duplicate`,
    fault: "at-least-once delivery",
    requestsIssued: 1,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: { ...tally(statuses), messagesHandled: lab.consumer.handledCount },
  };
}

async function scenarioFreshKeyPerRetry(retries: number): Promise<Row> {
  const lab = createLab();
  const statuses: string[] = [];
  for (let i = 0; i < retries; i++) {
    statuses.push((await lab.service.execute(cmd({ operationId: `fresh_uuid_${i}` }))).status);
  }
  await lab.deliver();
  const a = lab.audit();
  return {
    scenario: `caller mints a new operation id on every retry (x${retries})`,
    fault: "caller-side identity bug",
    requestsIssued: retries,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(statuses),
  };
}

async function scenarioExpiredIdentity(): Promise<Row> {
  const clock = deterministicClock();
  const lab = createLab({ clock, config: { identityRetentionMs: DAY_MS } });
  const statuses = [(await lab.service.execute(cmd())).status];
  await lab.deliver();
  clock.advance(DAY_MS + MINUTE_MS);
  await lab.service.pruneExpiredIdentities();
  statuses.push((await lab.service.execute(cmd())).status);
  const a = lab.audit();
  return {
    scenario: "retry arrives after the idempotency record was pruned",
    fault: "identity retention expiry",
    requestsIssued: 2,
    providerCalls: a.providerCalls,
    providerLookups: a.providerLookups,
    providerEffects: a.providerEffects,
    ledgerPostings: a.ledgerPostings,
    openOperations: a.openOperations,
    manualReview: a.manualReviewOperations,
    storeAborts: lab.store.stats.aborts,
    violations: a.violations.length,
    outcomes: tally(statuses),
  };
}

function markdown(rows: Row[]): string {
  const head =
    "| Scenario | Injected fault | Requests | Provider calls | Provider effects | Ledger postings | Open | Manual review | Invariant violations |\n" +
    "|---|---|---:|---:|---:|---:|---:|---:|---:|\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.scenario} | ${r.fault} | ${r.requestsIssued} | ${r.providerCalls} | ${r.providerEffects} | ${r.ledgerPostings} | ${r.openOperations} | ${r.manualReview} | ${r.violations} |`,
    )
    .join("\n");
  return head + body + "\n";
}

const rows: Row[] = [
  await scenarioSequentialRetries(100),
  await scenarioConcurrent(8),
  await scenarioLostResponse(5),
  await scenarioTimeoutNoEffect(),
  await scenarioRedelivery(3),
  await scenarioFreshKeyPerRetry(25),
  await scenarioExpiredIdentity(),
];

mkdirSync(RESULTS, { recursive: true });
const report = {
  generatedBy: "scripts/effect-report.ts",
  environment: "local, in-memory serializable store, deterministic provider simulator",
  label: "Synthetic test result",
  node: process.version,
  rows,
};
writeFileSync(join(RESULTS, "effect-report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(RESULTS, "effect-report.md"), markdown(rows));

const failed = rows.filter((r) => r.violations > 0);
process.stdout.write(markdown(rows));
process.stdout.write(`\nnode ${process.version}\nscenarios: ${rows.length}, with violations: ${failed.length}\n`);
if (failed.length > 0) {
  process.stdout.write(`FAIL: ${failed.map((f) => f.scenario).join("; ")}\n`);
  process.exit(1);
}
