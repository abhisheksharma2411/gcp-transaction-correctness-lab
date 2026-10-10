// The replay CLI.
//
//   node scripts/replay.ts --help
//   node scripts/replay.ts --aggregate ord-b --dry-run
//   node scripts/replay.ts --from 2026-02-04 --to 2026-02-05 --max 20
//
// A dry run is the default. Publishing requires --apply, spelled out, because
// an operator reaching for this tool is already having a bad day.

import { planReplay, applyReplay, recordDryRun, UnboundedReplayError } from "../src/replay.ts";
import { T0, TOPIC, buildWorld, effectIds } from "../src/scenarios.ts";
import type { ReplayScope } from "../src/replay.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;

function usage(): void {
  console.log(`replay -- bounded, auditable event replay (local model; no cloud project)

  --aggregate <id>   replay one aggregate's history
  --from <date>      ISO date, inclusive, on recorded time
  --to <date>        ISO date, inclusive, on recorded time
  --type <name>      restrict to one event type
  --max <n>          ceiling on how many events (default 25)
  --apply            actually publish; without it this is a dry run
  --help

A scope with neither --aggregate nor a time bound is refused.`);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`not a date: ${value}`);
  return ms;
}

function main(): number {
  if (has("--help") || has("-h")) {
    usage();
    return 0;
  }

  // A seeded world, so the CLI has something to replay without a cloud project.
  const world = buildWorld();
  const seed = [
    { orderId: "ord-a", sku: "sku-1", quantity: 2, atMs: T0 },
    { orderId: "ord-b", sku: "sku-2", quantity: 1, atMs: T0 + DAY },
    { orderId: "ord-b", sku: "sku-3", quantity: 4, atMs: T0 + DAY + 1 },
    { orderId: "ord-c", sku: "sku-4", quantity: 1, atMs: T0 + 2 * DAY },
  ];
  for (const s of seed) {
    world.source.confirm({
      orderId: s.orderId,
      operationId: `op-${s.orderId}-${s.atMs}`,
      lines: [{ sku: s.sku, quantity: s.quantity }],
      schemaVersion: 1,
      nowMs: s.atMs,
    });
  }
  world.relay.drain(T0 + 3 * DAY);
  world.inventory.drain(T0 + 3 * DAY + MINUTE);
  world.notifications.drain(T0 + 3 * DAY + MINUTE);

  const scope: ReplayScope = {
    ...(arg("--aggregate") === undefined ? {} : { aggregateId: arg("--aggregate")! }),
    ...(parseDate(arg("--from")) === undefined ? {} : { fromMs: parseDate(arg("--from"))! }),
    ...(parseDate(arg("--to")) === undefined ? {} : { toMs: parseDate(arg("--to"))! }),
    ...(arg("--type") === undefined ? {} : { eventTypes: [arg("--type")!] }),
    maxEvents: Number(arg("--max") ?? 25),
  };

  let plan;
  try {
    plan = planReplay(world.source.eventLog(), scope, "cli");
  } catch (err) {
    if (err instanceof UnboundedReplayError) {
      console.error(`refused: ${err.message}`);
      return 2;
    }
    throw err;
  }

  console.log(`scope: ${JSON.stringify(scope)}`);
  console.log(`matched ${plan.eventIds.length} event(s)${plan.truncated ? " (truncated by --max)" : ""}`);
  for (const e of plan.envelopes) {
    console.log(
      `  ${e.eventId}  ${e.aggregateType}:${e.aggregateId}#${e.sequence}  ` +
        `${e.eventType} v${e.schemaVersion}  recorded ${new Date(e.recordedAtMs).toISOString()}`,
    );
  }

  if (!has("--apply")) {
    recordDryRun(plan, T0 + 4 * DAY, world.trace);
    console.log("dry run: nothing published. Re-run with --apply to publish.");
    return 0;
  }

  const before = effectIds(world);
  const published = applyReplay(plan, world.broker, TOPIC, T0 + 4 * DAY, world.trace);
  world.inventory.drain(T0 + 4 * DAY + MINUTE);
  world.notifications.drain(T0 + 4 * DAY + MINUTE);
  const after = effectIds(world);

  const added = after.filter((x) => !before.includes(x));
  console.log(`published ${published} event(s)`);
  console.log(`protected effects before ${before.length}, after ${after.length}, new ${added.length}`);
  console.log(added.length === 0 ? "replay was effect-neutral" : `divergence: ${added.join(", ")}`);
  return added.length === 0 ? 0 : 1;
}

process.exit(main());
