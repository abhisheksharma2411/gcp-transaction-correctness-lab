// The lineage gate.
//
//   node scripts/lineage.ts            verify the standard run
//   node scripts/lineage.ts --controls run every negative control too
//   node scripts/lineage.ts --trace    print the audit trail
//
// Exit code 1 if the standard run has any finding, if a control fails to
// provoke the code it claims, or if the control designed to be too blunt is not
// recognised as too blunt.

import { runControls, standardRun } from "../src/controls.ts";

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

const run = standardRun();
let failed = false;

console.log(`standard run: ${run.detail.length} finding(s)`);
for (const d of run.detail) console.log(`  ${d}`);
if (run.detail.length > 0) failed = true;

if (has("--trace")) {
  console.log("");
  for (const line of run.world.trace.lines()) console.log(line);
}

if (has("--controls")) {
  console.log("");
  for (const c of runControls()) {
    if (c.mustBeRejected) {
      const ok = c.blunt;
      console.log(`${ok ? "ok  " : "FAIL"}  ${c.name}: blunt control ${ok ? "rejected" : "not rejected"}`);
      if (!ok) failed = true;
      continue;
    }
    const ok = c.detected && !c.blunt;
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${c.name}: expected ${c.expected.join(",")} got ${c.produced.join(",") || "nothing"}`,
    );
    if (!ok) failed = true;
  }
}

console.log(failed ? "lineage: FAIL" : "lineage: PASS");
process.exit(failed ? 1 : 0);
