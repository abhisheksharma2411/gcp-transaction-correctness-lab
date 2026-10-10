// Runs the conformance matrix and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Re-running produces
// byte-identical output.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MATRIX, MUTATIONS, runMatrix } from "../src/conformance.ts";
import { TransactionalInbox, RetryingWorkflow, WebhookEndpoint, operatorReplay } from "../src/boundaries.ts";
import { OperationProcessor } from "../src/processor.ts";
import { fingerprint } from "../src/fingerprint.ts";
import type { CaughtBy } from "../src/processor.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

const T0 = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;

// --- E1: the matrix ---------------------------------------------------------

const matrixResults = runMatrix();

// --- E2: one operation, every boundary, counted four ways -------------------

function fourWayTally() {
  const p = new OperationProcessor({ retentionMs: DAY });
  const inbox = new TransactionalInbox();
  const webhook = new WebhookEndpoint();
  const workflow = new RetryingWorkflow();
  const caught: Record<string, number> = {};
  const note = (c: CaughtBy | null) => {
    const k = c ?? "did-real-work";
    caught[k] = (caught[k] ?? 0) + 1;
  };

  const ctx = (origin: "api" | "inbox" | "workflow" | "provider" | "replay") => ({
    operationId: "op-7741",
    businessRef: "order-7741",
    fingerprint: fingerprint({ amount: 2500, currency: "EUR" }),
    origin,
    attempt: 1,
  });

  // A client that retried three times.
  for (let i = 0; i < 3; i += 1) note(p.submit(ctx("api"), T0 + i).caughtBy);
  // Two deliveries of the same publish, plus a redelivery after a lost ack.
  for (const [i, id] of ["msg-a", "msg-b"].entries()) {
    const r = inbox.deliver(id, ctx("inbox"), p, T0 + 10 + i);
    if (r !== "ALREADY_PROCESSED") note(r.caughtBy);
  }
  note(inbox.deliverWithLostAck("msg-a", ctx("inbox"), p, T0 + 20).caughtBy);
  // An orchestrator retrying a step four times.
  for (const r of workflow.runStep(ctx("workflow"), p, T0 + 30, { attempts: 4 })) note(r.caughtBy);
  // The provider telling us twice.
  for (const [i, e] of ["evt-1", "evt-1", "evt-2"].entries()) {
    const r = webhook.receive(e, ctx("provider"), p, T0 + 40 + i);
    if (r !== "DUPLICATE_EVENT") note(r.caughtBy);
  }
  // An operator replaying it during a recovery drill.
  note(operatorReplay(ctx("replay"), p, T0 + 60).caughtBy);

  return {
    tally: { ...p.tally },
    inboxSuppressed: inbox.suppressedCount,
    webhookSuppressed: webhook.suppressedCount,
    effectLedgerSuppressed: p.effects.suppressedCount,
    caughtBy: caught,
  };
}

const fourWay = fourWayTally();

/**
 * The same operation, after the idempotency record has aged out.
 *
 * The first scenario is reassuring and slightly misleading: the contract
 * catches everything, so the layers beneath it never have to. This one runs a
 * disaster-recovery replay a week later, against an evicted record, and shows
 * which layer is actually load-bearing once the key is gone.
 */
function afterEvictionTally() {
  const retentionMs = DAY;
  const p = new OperationProcessor({ retentionMs });
  const caught: Record<string, number> = {};
  const note = (c: CaughtBy | null) => {
    const k = c ?? "did-real-work";
    caught[k] = (caught[k] ?? 0) + 1;
  };
  const ctx = (operationId: string, origin: "api" | "replay") => ({
    operationId,
    businessRef: "order-9902",
    fingerprint: fingerprint({ amount: 4100, currency: "EUR" }),
    origin,
    attempt: 1,
  });

  note(p.submit(ctx("op-9902", "api"), T0).caughtBy);

  const later = T0 + 7 * DAY;
  const evicted = p.store.evictExpired(later, retentionMs);

  // A recovery run replays the same operation id...
  note(p.submit(ctx("op-9902", "replay"), later).caughtBy);
  // ...and a reconstructed one, where the id was regenerated from a backup.
  note(p.submit(ctx("op-9902-rebuilt", "replay"), later + 1).caughtBy);

  return { evicted, tally: { ...p.tally }, caughtBy: caught };
}

const afterEviction = afterEvictionTally();

// --- E3: negative controls --------------------------------------------------

const controls = MUTATIONS.map((m) => {
  const failed = runMatrix(undefined, m).filter((r) => !r.passed);
  return { removed: m, casesTurnedRed: failed.map((f) => f.id), detected: failed.length > 0 };
});

// --- write ------------------------------------------------------------------

const payload = {
  generatedFrom: "scripts/report.ts",
  evaluatedAt: new Date(T0).toISOString(),
  note: "Deterministic. No cloud project, no credentials, no network.",
  matrix: matrixResults,
  fourWayTally: fourWay,
  afterEvictionTally: afterEviction,
  negativeControls: controls,
};
writeFileSync(join(RESULTS, "conformance.json"), JSON.stringify(payload, null, 2) + "\n");

const lines: string[] = [];
lines.push("# multi-layer-idempotency results");
lines.push("");
lines.push("Generated by `scripts/report.ts`. Deterministic: no cloud project, no");
lines.push("credentials, no network.");
lines.push("");
lines.push("## Four numbers that are not the same number");
lines.push("");
lines.push("One logical operation, arriving through every boundary that can repeat it.");
lines.push("");
lines.push("| measured | count |");
lines.push("|---|---:|");
lines.push(`| copies that arrived | ${fourWay.tally.arrivals} |`);
lines.push(`| admitted past de-duplication | ${fourWay.tally.admitted} |`);
lines.push(`| calls made to the provider | ${fourWay.tally.providerAttempts} |`);
lines.push(`| **externally visible effects** | **${fourWay.tally.effects}** |`);
lines.push("");
lines.push("Counting arrivals and calling it load, or counting attempts and calling");
lines.push("it effects, is how a system looks idempotent on a dashboard while doing");
lines.push("the work twice.");
lines.push("");
lines.push("## Which layer stopped each arrival");
lines.push("");
lines.push("| layer | arrivals stopped |");
lines.push("|---|---:|");
for (const [k, v] of Object.entries(fourWay.caughtBy).sort()) {
  lines.push(`| ${k} | ${v} |`);
}
lines.push("");
lines.push(`Boundary-local de-duplication additionally suppressed ${fourWay.inboxSuppressed} inbox`);
lines.push(`and ${fourWay.webhookSuppressed} webhook arrivals before the contract was consulted.`);
lines.push("");
lines.push("## The same operation, after the record has aged out");
lines.push("");
lines.push(`A disaster-recovery replay seven days later, with ${afterEviction.evicted} record(s)`);
lines.push("evicted by the retention window. The contract now has nothing to say,");
lines.push("and the layers beneath it are the only thing standing between a replay");
lines.push("and a second effect.");
lines.push("");
lines.push("| layer | arrivals stopped |");
lines.push("|---|---:|");
for (const [k, v] of Object.entries(afterEviction.caughtBy).sort()) {
  lines.push(`| ${k} | ${v} |`);
}
lines.push("");
lines.push(`Arrivals ${afterEviction.tally.arrivals}, admitted ${afterEviction.tally.admitted}, ` +
  `**effects ${afterEviction.tally.effects}**.`);
lines.push("");
lines.push("This is the case that decides whether an idempotency key is a design or");
lines.push("a decoration. Every de-duplication window is finite, so every system");
lines.push("eventually runs this scenario -- usually during a recovery, which is the");
lines.push("worst moment to discover the answer.");
lines.push("");
lines.push("## Conformance matrix");
lines.push("");
lines.push("| case | covers | arrivals | effects | result |");
lines.push("|---|---|---:|---:|---|");
for (const r of matrixResults) {
  const c = MATRIX.find((m) => m.id === r.id)!;
  lines.push(`| **${r.id}** ${r.title} | ${c.covers} | ${r.arrivals} | ${r.effects} | ${r.passed ? "PASS" : "FAIL"} |`);
}
lines.push("");
const passed = matrixResults.filter((r) => r.passed).length;
lines.push(`**${passed}/${matrixResults.length} cases pass.**`);
lines.push("");
lines.push("## Negative controls");
lines.push("");
lines.push("A matrix written by the same hand as the implementation proves nothing");
lines.push("until each case has been shown to fail when its layer is removed.");
lines.push("");
lines.push("| layer removed | cases that turn red | detected |");
lines.push("|---|---|---|");
for (const c of controls) {
  lines.push(`| ${c.removed} | ${c.casesTurnedRed.join(", ") || "—"} | ${c.detected ? "yes" : "**no**"} |`);
}
lines.push("");
writeFileSync(join(RESULTS, "report.md"), lines.join("\n"));

console.log("wrote results/conformance.json and results/report.md");
