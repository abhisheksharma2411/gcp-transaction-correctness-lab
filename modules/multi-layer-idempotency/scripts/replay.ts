// Operator replay.
//
//   node scripts/replay.ts --op op-7741 --ref order-7741 --amount 2500
//   node scripts/replay.ts --op op-7741 --ref order-7741 --amount 2500 --evicted
//   node scripts/replay.ts --help
//
// The boundary with no de-duplication of its own: a human has decided to re-run
// something. Everything that stops this from duplicating an effect lives below
// it, which makes replay the honest test of whether those layers work.
//
// Runs entirely against the local model. Touches nothing real.

import { OperationProcessor } from "../src/processor.ts";
import { operatorReplay } from "../src/boundaries.ts";
import { fingerprint } from "../src/fingerprint.ts";

const DAY = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.includes("--help") || process.argv.length <= 2) {
  console.log(`operator replay — re-run one operation against the local model

  --op <id>        operation id to replay          (default: op-demo)
  --ref <ref>      protected business reference    (default: order-demo)
  --amount <n>     request amount                  (default: 2500)
  --evicted        age the record out first, so the contract cannot help
  --new-id <id>    replay under a different id, as a rebuilt record would

No cloud project, no credentials, no network.`);
  process.exit(0);
}

const operationId = arg("op") ?? "op-demo";
const businessRef = arg("ref") ?? "order-demo";
const amount = Number(arg("amount") ?? 2500);
const evicted = process.argv.includes("--evicted");
const newId = arg("new-id");

if (!Number.isFinite(amount)) {
  console.error("--amount must be a number");
  process.exit(2);
}

const T0 = Date.UTC(2026, 0, 5);
const processor = new OperationProcessor({ retentionMs: DAY });
const base = {
  businessRef,
  fingerprint: fingerprint({ amount, currency: "EUR" }),
  attempt: 1,
};

const first = processor.submit({ ...base, operationId, origin: "api" }, T0);
console.log(`original   decision=${first.decision} effect=${first.effectApplied}`);

let at = T0 + 60_000;
if (evicted) {
  at = T0 + 7 * DAY;
  const n = processor.store.evictExpired(at, DAY);
  console.log(`evicted    ${n} record(s) aged out of the retention window`);
}

const replayId = newId ?? operationId;
const replayed = operatorReplay({ ...base, operationId: replayId, origin: "replay" }, processor, at);

console.log(
  `replay     decision=${replayed.decision} ` +
    `caughtBy=${replayed.caughtBy ?? "nothing — it did real work"} ` +
    `effect=${replayed.effectApplied}`,
);
if (replayed.detail) console.log(`           ${replayed.detail}`);
console.log("");
console.log(
  `arrivals=${processor.tally.arrivals} admitted=${processor.tally.admitted} ` +
    `providerAttempts=${processor.tally.providerAttempts} effects=${processor.tally.effects}`,
);

if (processor.tally.effects !== 1) {
  console.error(`\nEXPECTED exactly one effect, got ${processor.tally.effects}`);
  process.exit(1);
}
