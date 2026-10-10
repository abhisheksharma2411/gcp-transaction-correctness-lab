// Runs the demo ledger and writes results/ deterministically.
//
//   node scripts/report.ts
//
// No cloud project, no credentials, no network. Re-running produces
// byte-identical output; `make verify` depends on that.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { balancesFor, inNormalDirection, trialBalance } from "../src/balances.ts";
import { checkLedger } from "../src/invariants.ts";
import { formatAmount } from "../src/money.ts";
import { BalanceProjection, completeTransactions, partitionRecords, partitionsOf } from "../src/projection.ts";
import { MUTATIONS, emptyLedgerControl } from "../src/mutations.ts";
import { ACCOUNTS, AS_OF, buildScenario } from "../src/scenario.ts";
import type { AccountKind } from "../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "..", "results");
mkdirSync(RESULTS, { recursive: true });

const { ledger } = buildScenario();
const projection = new BalanceProjection();
projection.consumeAll(ledger.feed());
const proof = checkLedger(ledger, projection, AS_OF);

// --- E1: the proof report ---------------------------------------------------

const invariantRows = proof.invariants.map((i) => ({
  id: i.id,
  name: i.name,
  covers: i.covers,
  status: i.status,
  population: i.population,
}));

// --- E2: the mutation matrix ------------------------------------------------

const mutationRows = MUTATIONS.map((mutation) => {
  const report = mutation.run();
  const reddened = report.invariants
    .filter((i) => i.status === "VIOLATED")
    .map((i) => i.id)
    .sort();
  return {
    id: mutation.id,
    name: mutation.name,
    removes: mutation.removes,
    expected: [...mutation.expectViolated].sort(),
    reddened,
    agrees: JSON.stringify(reddened) === JSON.stringify([...mutation.expectViolated].sort()),
    verdict: report.summary.verdict,
  };
});

const control = emptyLedgerControl();

// --- E3: four balances for one account --------------------------------------

const walletKind: AccountKind = ledger.account(ACCOUNTS.wallet)?.kind ?? "LIABILITY";
const wallet = balancesFor(ledger, ACCOUNTS.wallet, AS_OF);
const walletRows = [
  { label: "accounting balance", minor: inNormalDirection(walletKind, wallet.accounting) },
  { label: "current balance", minor: inNormalDirection(walletKind, wallet.current) },
  { label: "pending (held)", minor: inNormalDirection(walletKind, wallet.pending) },
  { label: "available balance", minor: inNormalDirection(walletKind, wallet.available) },
].map((row) => ({
  ...row,
  formatted: formatAmount({ currency: wallet.currency, minor: row.minor }),
  minor: row.minor.toString(),
}));

// --- E4: what one partition of the change stream shows ----------------------

const feed = ledger.feed();
const partitionRows = partitionsOf(feed).map((partition) => {
  const records = partitionRecords(feed, partition);
  const { complete, partial } = completeTransactions(records);
  return {
    partition,
    records: records.length,
    completeTransactions: complete.length,
    partialTransactions: partial.length,
  };
});
const wholeFeed = completeTransactions(feed);

// --- E5: the cost of one journal, counted the way the quota page counts it --

const postingColumns = 8;
const journalColumns = 11;
const costRows = ledger.allJournals().map((journal) => ({
  journal: journal.businessRef,
  postings: journal.postings.length,
  mutations: journalColumns + journal.postings.length * postingColumns,
}));
const widest = costRows.reduce((a, b) => (b.mutations > a.mutations ? b : a), costRows[0] ?? {
  journal: "",
  postings: 0,
  mutations: 0,
});

// --- E6: the audit export ---------------------------------------------------

const auditExport = {
  ledgerId: ledger.ledgerId,
  asOf: AS_OF,
  chainHead: ledger.chainHead(),
  accounts: ledger.allAccounts().map((a) => ({
    accountId: a.accountId,
    kind: a.kind,
    currency: a.currency,
    path: a.path,
    isPending: a.isPending,
  })),
  journals: ledger.allJournals().map((j) => ({
    journalId: j.journalId,
    businessRef: j.businessRef,
    effectiveAt: j.effectiveAt,
    recordedAt: j.recordedAt,
    description: j.description,
    reversesJournalId: j.reversesJournalId,
    contentHash: j.contentHash,
    chainHash: j.chainHash,
    fxNote:
      j.fxNote === null
        ? null
        : {
            fromCurrency: j.fxNote.fromCurrency,
            toCurrency: j.fxNote.toCurrency,
            rate: `${j.fxNote.rateNumerator}/${j.fxNote.rateDenominator}`,
            rateSource: j.fxNote.rateSource,
          },
    postings: j.postings.map((p) => ({
      postingId: p.postingId,
      lineNumber: p.lineNumber,
      accountId: p.accountId,
      direction: p.direction,
      currency: p.amount.currency,
      amount: formatAmount(p.amount),
      memo: p.memo,
    })),
  })),
  rejected: ledger.rejectionLog().map((r) => ({
    businessRef: r.command.businessRef,
    code: r.code,
    detail: r.detail,
  })),
  balances: ledger.allAccounts().map((a) => {
    const set = balancesFor(ledger, a.accountId, AS_OF);
    return {
      accountId: a.accountId,
      currency: a.currency,
      normalDirection: a.kind === "ASSET" || a.kind === "EXPENSE" ? "DEBIT" : "CREDIT",
      accounting: formatAmount({
        currency: a.currency,
        minor: inNormalDirection(a.kind, set.accounting),
      }),
      evidencePostings: set.evidence,
    };
  }),
};

// --- write ------------------------------------------------------------------

writeFileSync(join(RESULTS, "proof.json"), `${JSON.stringify(proof, bigintSafe, 2)}\n`);
writeFileSync(
  join(RESULTS, "mutations.json"),
  `${JSON.stringify({ mutations: mutationRows, control: control.summary }, bigintSafe, 2)}\n`,
);
writeFileSync(join(RESULTS, "audit-export.json"), `${JSON.stringify(auditExport, bigintSafe, 2)}\n`);

const tb = [...trialBalance(ledger).entries()].sort(([a], [b]) => (a < b ? -1 : 1));

const md = `# double-entry-ledger — results

Generated by \`node scripts/report.ts\`. Every figure below is a **Simulated
result** from the synthetic ledger in \`src/scenario.ts\`. No cloud project, no
credentials, no network.

Ledger: \`${ledger.ledgerId}\` · as of ${AS_OF} · ${ledger.allJournals().length} journals · ${ledger.allPostings().length} postings
Chain head: \`${ledger.chainHead()}\`

## E1 — the proof report

Verdict: **${proof.summary.verdict}** (${proof.summary.holds} hold, ${proof.summary.violated} violated, ${proof.summary.vacuous} vacuous)
Report digest: \`${proof.digest}\`

| invariant | what it uniquely catches | examined | status |
|---|---|---:|---|
${invariantRows
  .map((r) => `| ${r.id} ${r.name} | ${r.covers} | ${r.population} | ${r.status} |`)
  .join("\n")}

A row that examined 0 items would make the whole report \`INCONCLUSIVE\`
rather than \`PROVEN\`.

## E2 — the mutation matrix

Each mutation removes one mechanism. The expectation names the invariants that
must go red, and the test fails if a different set goes red.

| mutation | mechanism removed | invariants reddened |
|---|---|---|
${mutationRows.map((r) => `| ${r.id} ${r.name} | ${r.removes} | ${r.reddened.join(", ")} |`).join("\n")}

Blunt control — an empty ledger: ${control.summary.violated} violations, ${control.summary.vacuous} vacuous, verdict **${control.summary.verdict}**.
Nothing broke, and nothing was proven. That is why it is rejected as evidence.

## E3 — four numbers people call "the balance"

Account \`${ACCOUNTS.wallet}\` (${walletKind}, ${wallet.currency}), presented in its normal direction:

| figure | ${wallet.currency} |
|---|---:|
${walletRows.map((r) => `| ${r.label} | ${r.formatted} |`).join("\n")}

The accounting balance names ${wallet.evidence.length} postings as its evidence.

## E4 — what one change stream partition shows

| partition | records | whole journals | partial journals |
|---|---:|---:|---:|
${partitionRows
  .map((r) => `| ${r.partition} | ${r.records} | ${r.completeTransactions} | ${r.partialTransactions} |`)
  .join("\n")}

Across the whole feed: ${wholeFeed.complete.length} whole, ${wholeFeed.partial.length} partial.
A consumer reading one partition sees journals that do not balance. A consumer
reading all of them, buffering by transaction id, does not.

## E5 — what a journal costs, in mutations

Counted the way the quota page counts: one per column written, per row.
A posting here has ${postingColumns} columns and a journal header has ${journalColumns}.

| journal | postings | mutations |
|---|---:|---:|
${costRows.map((r) => `| ${r.journal} | ${r.postings} | ${r.mutations} |`).join("\n")}

The largest journal in this ledger costs ${widest.mutations} mutations against a limit of 80,000.
At ${postingColumns} columns a posting, one commit holds about ${Math.floor((80_000 - journalColumns) / postingColumns).toLocaleString("en-US")} postings before the limit refuses it.

## E6 — trial balance

| currency | debits | credits | difference |
|---|---:|---:|---:|
${tb
  .map(
    ([currency, { debits, credits }]) =>
      `| ${currency} | ${formatAmount({ currency, minor: debits })} | ${formatAmount({ currency, minor: credits })} | ${formatAmount({ currency, minor: debits - credits })} |`,
  )
  .join("\n")}

## Files

- \`proof.json\` — the machine-readable proof report
- \`mutations.json\` — the negative controls and what each one reddened
- \`audit-export.json\` — every journal, posting, hash and balance, with the postings each balance cites
`;

writeFileSync(join(RESULTS, "report.md"), md);

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

if (proof.summary.verdict !== "PROVEN") {
  console.error(`proof verdict is ${proof.summary.verdict}`);
  process.exit(1);
}
for (const row of mutationRows) {
  if (!row.agrees) {
    console.error(`${row.id} reddened ${row.reddened.join(",")}, expected ${row.expected.join(",")}`);
    process.exit(1);
  }
}
console.log(`wrote results/proof.json, results/mutations.json, results/audit-export.json, results/report.md`);
