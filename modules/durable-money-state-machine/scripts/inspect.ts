// Operator tooling: show one payout's history and explain where it is.
//
//   node scripts/inspect.ts --scenario S17
//   node scripts/inspect.ts --list
//   node scripts/inspect.ts --help
//
// The reason this exists is the reason the history exists. An operator looking
// at a stuck payout at two in the morning needs to know what moved it, who
// moved it, and what it is waiting for -- and reading that out of application
// logs means reconstructing intent from the exhaust of a process rather than
// from its record.

import { SCENARIOS } from "../src/scenarios.ts";
import { SPECS } from "../src/spec.ts";
import { TERMINAL_OF } from "../src/policy.ts";
import type { State } from "../src/types.ts";

const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

if (args.includes("--help") || args.length === 0) {
  console.log(`inspect -- show a payout's transition history

  node scripts/inspect.ts --list            list the scenarios
  node scripts/inspect.ts --scenario S17    run one and print its history

No cloud project, no credentials, no network.`);
  process.exit(0);
}

if (args.includes("--list")) {
  for (const s of SCENARIOS) console.log(`${s.id}  ${s.title}`);
  process.exit(0);
}

const id = flag("scenario");
const scenario = SCENARIOS.find((s) => s.id === id);
if (scenario === undefined) {
  console.error(`no scenario ${String(id)}; try --list`);
  process.exit(2);
}

const t = scenario.run();
const spec = SPECS[t.history[t.history.length - 1]!.specVersion];

console.log(`${scenario.id}  ${scenario.title}`);
console.log(`covers: ${scenario.covers}`);
console.log("");
console.log("seq  from -> to                       trigger             actor            reason");
console.log("---  --------------------------------  ------------------  ---------------  ------");
for (const r of t.history) {
  const move = `${r.from} -> ${r.to}`.padEnd(32);
  console.log(
    `${String(r.seq).padStart(3)}  ${move}  ${r.trigger.padEnd(18)}  ${r.actorId.padEnd(15)}  ${r.reasonCode}`,
  );
}
console.log("");
console.log(`state: ${t.finalState}`);
if (TERMINAL_OF(spec).has(t.finalState as State)) {
  console.log("this payout is finished and does not reopen");
} else {
  const wait = spec.waits[t.finalState as State];
  if (wait === undefined) {
    console.log("nothing outside the system is being waited on; a worker can move this now");
  } else {
    console.log(`waiting on: ${wait.owner}`);
    console.log(`deadline:   ${Math.round(wait.deadlineMs / 3_600_000)}h, enforced by ${wait.mechanism}`);
    if (wait.escalatesTo !== undefined) console.log(`escalates:  ${wait.escalatesTo}`);
  }
}
console.log(`provider submissions: ${t.providerSubmissions}`);
console.log(`refusals: ${t.refusals.join(", ") || "none"}`);
