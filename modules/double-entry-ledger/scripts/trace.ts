// Trace one journal from command to change stream.
//
//   node scripts/trace.ts --ref fee-9004
//
// Prints the journal, its postings, the reversal that corrects it, and the
// change stream records each one produced. Nothing is written.

import { formatAmount } from "../src/money.ts";
import { AS_OF, buildScenario } from "../src/scenario.ts";
import { balancesFor } from "../src/balances.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/trace.ts [--ref <businessRef>]");
  process.exit(0);
}
const refIndex = args.indexOf("--ref");
const wanted = refIndex >= 0 ? args[refIndex + 1] : "fee-9004";
if (wanted === undefined) {
  console.error("--ref needs a business reference");
  process.exit(2);
}

const { ledger } = buildScenario();
const journals = ledger.allJournals();
const target = journals.find((j) => j.businessRef === wanted);
if (target === undefined) {
  console.error(`no journal with business reference ${wanted}`);
  console.error(`available: ${journals.map((j) => j.businessRef).join(", ")}`);
  process.exit(2);
}

const related = journals.filter(
  (j) => j.journalId === target.journalId || j.reversesJournalId === target.journalId,
);

for (const journal of related) {
  const kind = journal.reversesJournalId === null ? "journal" : "reversal";
  console.log(`\n== ${kind} ${journal.businessRef} (${journal.journalId})`);
  console.log(`   effective ${journal.effectiveAt}   recorded ${journal.recordedAt}`);
  console.log(`   ${journal.description}`);
  if (journal.reversesJournalId !== null) console.log(`   reverses ${journal.reversesJournalId}`);
  console.log(`   content ${journal.contentHash}  chain ${journal.chainHash}`);
  for (const posting of journal.postings) {
    const amount = formatAmount(posting.amount).padStart(10);
    console.log(
      `   ${String(posting.lineNumber).padStart(2)}  ${posting.direction.padEnd(6)} ${amount} ${posting.amount.currency}  ${posting.accountId.padEnd(26)} ${posting.postingId}`,
    );
  }
  const records = ledger
    .feed()
    .filter((r) => r.posting.journalId === journal.journalId)
    .sort((a, b) => a.recordSequence - b.recordSequence);
  console.log(`   change stream: ${records.length} records in ${new Set(records.map((r) => r.partition)).size} partitions`);
  for (const record of records) {
    console.log(
      `     ${record.partition}  seq ${record.recordSequence}/${record.numberOfRecordsInTransaction}  ${record.commitTimestamp}  ${record.serverTransactionId}  ${record.posting.postingId}`,
    );
  }
}

console.log("\n== net effect of the pair, by account");
const touched = [...new Set(related.flatMap((j) => j.postings.map((p) => p.accountId)))].sort();
for (const accountId of touched) {
  const net = related
    .flatMap((j) => j.postings)
    .filter((p) => p.accountId === accountId)
    .reduce((total, p) => total + (p.direction === "DEBIT" ? p.amount.minor : -p.amount.minor), 0n);
  const account = ledger.account(accountId);
  const currency = account?.currency ?? "USD";
  console.log(`   ${accountId.padEnd(26)} ${formatAmount({ currency, minor: net }).padStart(10)} ${currency}`);
}

console.log("\n== ledger-wide balance of each touched account, as of", AS_OF);
for (const accountId of touched) {
  const set = balancesFor(ledger, accountId, AS_OF);
  console.log(
    `   ${accountId.padEnd(26)} ${formatAmount({ currency: set.currency, minor: set.accounting }).padStart(10)} ${set.currency}  from ${set.evidence.length} postings`,
  );
}
