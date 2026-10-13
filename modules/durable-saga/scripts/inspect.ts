// Print one saga's timeline.
//
//   node scripts/inspect.ts --scenario S7
//   node scripts/inspect.ts --list
//
// The timeline is the artifact an operator actually needs: what was sent, what
// came back, which transition it caused, and under which reason code.

import { SCENARIOS, scenarioById } from "../src/scenarios.ts";
import { timeline } from "../src/matrix.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.length === 0) {
  console.log("usage: node scripts/inspect.ts --scenario <id> | --list");
  process.exit(0);
}

if (args.includes("--list")) {
  for (const s of SCENARIOS) console.log(`${s.id}  ${s.title} — ${s.covers}`);
  process.exit(0);
}

const i = args.indexOf("--scenario");
const id = i >= 0 ? args[i + 1] : undefined;
if (id === undefined) {
  console.error("no scenario given; try --list");
  process.exit(2);
}

const s = scenarioById(id);
const r = s.run();
console.log(`${s.id}: ${s.title}`);
console.log(`covers: ${s.covers}`);
console.log("");
console.log("seq | time     | event | step | reason code | detail");
for (const line of timeline(r.record)) console.log(line);
console.log("");
console.log(`final state   ${r.record.state}`);
console.log(`ledgers say   ${r.audit.verdict}`);
console.log(`agreement     ${r.disagreement ?? "the saga and the ledgers agree"}`);
