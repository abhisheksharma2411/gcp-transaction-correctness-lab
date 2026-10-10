// Everything downstream of the specification, generated from it.
//
//   node scripts/generate.ts            write the artifacts
//   node scripts/generate.ts --check    fail if any of them has drifted
//
// The --check mode is the point. Generated documentation that nobody
// regenerates is worse than no documentation, because it is confidently wrong.
// Wiring the check into `make verify` makes drift a build failure rather than
// a thing a reader discovers.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SPEC_V1, SPEC_V2, forbiddenPairs } from "../src/spec.ts";
import type { Spec } from "../src/spec.ts";
import { verify } from "../src/verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const check = process.argv.includes("--check");

// --- JSON: the machine-readable export --------------------------------------

function toJson(spec: Spec): unknown {
  return {
    version: spec.version,
    initial: spec.initial,
    states: spec.states,
    terminal: spec.terminal,
    autonomous: spec.autonomous,
    waits: Object.fromEntries(
      Object.entries(spec.waits).map(([state, w]) => [state, {
        owner: w!.owner,
        deadlineMs: w!.deadlineMs,
        mechanism: w!.mechanism,
        ...(w!.escalatesTo === undefined ? {} : { escalatesTo: w!.escalatesTo }),
        note: w!.note,
      }]),
    ),
    transitions: spec.transitions.map((t) => ({
      from: t.from, trigger: t.trigger, to: t.to,
      reasonCode: t.reasonCode, guards: t.guards, note: t.note,
    })),
    guards: Object.keys(spec.guards).sort(),
  };
}

const json = JSON.stringify(
  { generatedFrom: "src/spec.ts", specs: [toJson(SPEC_V1), toJson(SPEC_V2)] },
  null, 2,
) + "\n";

// --- Mermaid: the visualisation ---------------------------------------------

function toMermaid(spec: Spec): string {
  const lines: string[] = [];
  lines.push("%% generated from src/spec.ts by scripts/generate.ts -- do not edit");
  lines.push("stateDiagram-v2");
  lines.push(`    [*] --> ${spec.initial}`);
  for (const t of spec.transitions) {
    const guards = t.guards.length > 0 ? ` [${t.guards.join(", ")}]` : "";
    lines.push(`    ${t.from} --> ${t.to}: ${t.trigger}${guards}`);
  }
  for (const s of spec.terminal) lines.push(`    ${s} --> [*]`);
  for (const [state, w] of Object.entries(spec.waits)) {
    lines.push(`    note right of ${state}`);
    lines.push(`        waits on ${w!.owner}`);
    lines.push(`        deadline ${Math.round(w!.deadlineMs / 3_600_000)}h via ${w!.mechanism}`);
    lines.push("    end note");
  }
  return lines.join("\n") + "\n";
}

const mermaid = toMermaid(SPEC_V2);

// --- Markdown: the transition documentation ---------------------------------

function toMarkdown(spec: Spec): string {
  const l: string[] = [];
  l.push(`## Specification version ${spec.version}`);
  l.push("");
  l.push(`Initial state \`${spec.initial}\`. Terminal states ${spec.terminal.map((s) => `\`${s}\``).join(", ")}.`);
  l.push("");
  l.push("### Transitions");
  l.push("");
  l.push("| from | trigger | to | guards | reason code |");
  l.push("|---|---|---|---|---|");
  for (const t of spec.transitions) {
    const g = t.guards.length === 0 ? "—" : t.guards.map((x) => `\`${x}\``).join("<br>");
    l.push(`| \`${t.from}\` | \`${t.trigger}\` | \`${t.to}\` | ${g} | \`${t.reasonCode}\` |`);
  }
  l.push("");
  l.push("### Why each row exists");
  l.push("");
  for (const t of spec.transitions) {
    l.push(`- **\`${t.from}\` --\`${t.trigger}\`--> \`${t.to}\`** — ${t.note}`);
  }
  l.push("");
  l.push("### Waiting conditions");
  l.push("");
  l.push("Every non-terminal state that nothing inside the system can move on its");
  l.push("own must name who it is waiting for and how long the wait may last.");
  l.push("");
  l.push("| state | waits on | deadline | mechanism | escalates to |");
  l.push("|---|---|---:|---|---|");
  for (const [state, w] of Object.entries(spec.waits)) {
    const hours = (w!.deadlineMs / 3_600_000).toFixed(0);
    l.push(`| \`${state}\` | ${w!.owner} | ${hours}h | ${w!.mechanism} | ${w!.escalatesTo ?? "—"} |`);
  }
  l.push("");
  l.push("### Forbidden pairs");
  l.push("");
  const forbidden = forbiddenPairs(spec);
  l.push(`${forbidden.length} of the ${spec.states.length * 11} (state, trigger) combinations have no row.`);
  l.push("An attempt at any of them is refused with `NO_SUCH_TRANSITION` if the entity is live,");
  l.push("or `TERMINAL` if it has finished.");
  l.push("");
  l.push("### Verification");
  l.push("");
  l.push("| check | result | detail |");
  l.push("|---|---|---|");
  for (const f of verify(spec)) {
    l.push(`| \`${f.check}\` | ${f.ok ? "PASS" : "**FAIL**"} | ${f.detail} |`);
  }
  l.push("");
  return l.join("\n");
}

const markdown = [
  "# State machine",
  "",
  "**Generated from `src/spec.ts` by `scripts/generate.ts`. Do not edit.**",
  "",
  "`make verify` fails if this file drifts from the specification, which is the",
  "only reason to trust it.",
  "",
  toMarkdown(SPEC_V2),
  "---",
  "",
  toMarkdown(SPEC_V1),
].join("\n");

// --- write or check ---------------------------------------------------------

const artifacts: readonly { path: string; content: string }[] = [
  { path: join(ROOT, "state-machine.json"), content: json },
  { path: join(ROOT, "docs", "STATE_MACHINE.md"), content: markdown },
  { path: join(ROOT, "results", "state-machine.mmd"), content: mermaid },
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
    console.error("generated artifacts have drifted from src/spec.ts:");
    for (const d of drifted) console.error(`  ${d}`);
    console.error("run: node scripts/generate.ts");
    process.exit(1);
  }
  console.log(`generate --check: PASS (${artifacts.length} artifacts match src/spec.ts)`);
} else {
  for (const a of artifacts) writeFileSync(a.path, a.content);
  console.log(`wrote ${artifacts.length} artifacts from src/spec.ts`);
}
