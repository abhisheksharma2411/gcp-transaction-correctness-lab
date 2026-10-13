// Everything downstream of the saga definition, generated from it.
//
//   node scripts/generate.ts            write the artifacts
//   node scripts/generate.ts --check    fail if any of them has drifted
//
// Five artifacts: the JSON export, the transition documentation, a Mermaid
// source, and the two SVGs that ship with the article. The --check mode runs
// inside `make verify`, so a definition edited without regenerating is a build
// failure rather than something a reader notices.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SAGA_V1, SAGA_V2, compensableSteps, pivotIndex, verifyDefinition } from "../src/saga.ts";
import type { Definition } from "../src/saga.ts";
import { sagaFlowSvg, sagaStatesSvg } from "../src/svg.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const check = process.argv.includes("--check");

function toJson(def: Definition): unknown {
  return {
    version: def.version,
    name: def.name,
    pivot: def.steps[pivotIndex(def)]!.name,
    steps: def.steps.map((s) => ({
      name: s.name, participant: s.participant, does: s.does,
      compensation: s.compensation, compensationDoes: s.compensationDoes,
      pivot: s.pivot, async: s.async, irreversible: s.irreversible,
      maxAttempts: s.maxAttempts, note: s.note,
    })),
    states: def.states,
    terminal: def.terminal,
    owned: def.owned,
    transitions: def.transitions.map((t) => ({
      from: t.from, trigger: t.trigger, to: t.to, reasonCode: t.reasonCode, note: t.note,
    })),
    layout: def.layout,
    routes: def.routes,
  };
}

const json = JSON.stringify(
  { generatedFrom: "src/saga.ts", definitions: [toJson(SAGA_V1), toJson(SAGA_V2)] },
  null, 2,
) + "\n";

function toMermaid(def: Definition): string {
  const l: string[] = [];
  l.push("%% generated from src/saga.ts by scripts/generate.ts -- do not edit");
  l.push("stateDiagram-v2");
  l.push("    [*] --> RUNNING");
  for (const t of def.transitions) l.push(`    ${t.from} --> ${t.to}: ${t.trigger}`);
  for (const s of def.terminal) l.push(`    ${s} --> [*]`);
  for (const s of def.states) {
    const owner = def.owned[s];
    if (owner === undefined) continue;
    l.push(`    note right of ${s}`);
    l.push(`        left only by ${owner}`);
    l.push("    end note");
  }
  return l.join("\n") + "\n";
}

function toMarkdown(def: Definition): string {
  const l: string[] = [];
  const pivot = def.steps[pivotIndex(def)]!;
  l.push(`## Definition version ${def.version}`);
  l.push("");
  l.push(`${def.steps.length} steps across ${new Set(def.steps.map((s) => s.participant)).size} participants. The pivot is \`${pivot.name}\`.`);
  l.push("");
  l.push("### Steps");
  l.push("");
  l.push("| # | step | participant | does | compensation | role | attempts |");
  l.push("|---:|---|---|---|---|---|---:|");
  def.steps.forEach((s, i) => {
    const role = s.pivot ? "**pivot**" : i < pivotIndex(def) ? "compensable" : s.irreversible ? "retryable, irreversible" : "retryable";
    l.push(`| ${i + 1} | \`${s.name}\` | ${s.participant} | ${s.does} | ${s.compensation === null ? "—" : `\`${s.compensation}\``} | ${role} | ${s.maxAttempts} |`);
  });
  l.push("");
  l.push("### Why each step sits where it does");
  l.push("");
  for (const s of def.steps) l.push(`- **\`${s.name}\`** — ${s.note}`);
  l.push("");
  l.push("### The compensation chain");
  l.push("");
  const chain = compensableSteps(def).slice().reverse();
  l.push(`Reverse dispatch order: ${chain.map((s) => `\`${s.compensation}\``).join(" → ")}.`);
  l.push("");
  l.push("The chain walks the steps that were **dispatched**, not the steps that");
  l.push("answered. A step whose response never arrived has, as far as the");
  l.push("orchestrator can tell, happened.");
  l.push("");
  l.push("### States");
  l.push("");
  l.push("| state | terminal | left only by |");
  l.push("|---|---|---|");
  for (const s of def.states) {
    l.push(`| \`${s}\` | ${def.terminal.includes(s) ? "yes" : "no"} | ${def.owned[s] ?? "—"} |`);
  }
  l.push("");
  l.push("### Transitions");
  l.push("");
  l.push("| from | trigger | to | reason code |");
  l.push("|---|---|---|---|");
  for (const t of def.transitions) {
    l.push(`| \`${t.from}\` | \`${t.trigger}\` | \`${t.to}\` | \`${t.reasonCode}\` |`);
  }
  l.push("");
  l.push("### Why each transition exists");
  l.push("");
  for (const t of def.transitions) {
    l.push(`- **\`${t.from}\` --\`${t.trigger}\`--> \`${t.to}\`** — ${t.note}`);
  }
  l.push("");
  l.push("### Verification");
  l.push("");
  l.push("| check | result | detail |");
  l.push("|---|---|---|");
  for (const f of verifyDefinition(def)) {
    l.push(`| \`${f.check}\` | ${f.ok ? "PASS" : "**FAIL**"} | ${f.detail} |`);
  }
  l.push("");
  return l.join("\n");
}

const markdown = [
  "# The saga definition",
  "",
  "**Generated from `src/saga.ts` by `scripts/generate.ts`. Do not edit.**",
  "",
  "`make verify` fails if this file, `saga.json`, `results/saga.mmd` or either",
  "of the two generated SVGs has drifted from the definition. That drift check",
  "is the only reason to believe any of them.",
  "",
  toMarkdown(SAGA_V1),
  "---",
  "",
  toMarkdown(SAGA_V2),
].join("\n");

const artifacts: readonly { path: string; content: string }[] = [
  { path: join(ROOT, "saga.json"), content: json },
  { path: join(ROOT, "docs", "SAGA.md"), content: markdown },
  { path: join(ROOT, "results", "saga.mmd"), content: toMermaid(SAGA_V1) },
  { path: join(ROOT, "results", "saga-flow.svg"), content: sagaFlowSvg(SAGA_V1) },
  { path: join(ROOT, "results", "saga-states.svg"), content: sagaStatesSvg(SAGA_V1) },
];

mkdirSync(join(ROOT, "docs"), { recursive: true });
mkdirSync(join(ROOT, "results"), { recursive: true });

if (check) {
  const drifted: string[] = [];
  for (const a of artifacts) {
    if (!existsSync(a.path)) { drifted.push(`${a.path} (missing)`); continue; }
    if (readFileSync(a.path, "utf8") !== a.content) drifted.push(a.path);
  }
  if (drifted.length > 0) {
    console.error("generated artifacts have drifted from src/saga.ts:");
    for (const d of drifted) console.error(`  ${d}`);
    console.error("run: node scripts/generate.ts");
    process.exit(1);
  }
  console.log(`generate --check: PASS (${artifacts.length} artifacts match src/saga.ts)`);
} else {
  for (const a of artifacts) writeFileSync(a.path, a.content);
  console.log(`wrote ${artifacts.length} artifacts from src/saga.ts`);
}
