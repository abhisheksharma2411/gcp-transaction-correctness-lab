// Scenarios shared by the tests and the report.
//
// Keeping them in one place means the numbers in results/report.md are produced
// by the same code the tests assert on. A report that runs its own private
// setup is a second system, and a second system is a second set of bugs.

import { Broker } from "./broker.ts";
import { Consumer, inventoryHandler, notificationHandler } from "./consumer.ts";
import { verifyLineage } from "./lineage.ts";
import { OutboxRelay } from "./relay.ts";
import { OrderService, SimulatedCrash } from "./source.ts";
import { Trace } from "./trace.ts";
import type { ConsumerMutation } from "./consumer.ts";
import type { LineageReport } from "./lineage.ts";
import type { CaptureStrategy } from "./source.ts";
import type { CrashPoint, EventEnvelope, SchemaVersion } from "./types.ts";

export const TOPIC = "orders";
export const DEAD_LETTER = "orders-dead-letter";
export const T0 = Date.UTC(2026, 1, 3, 9, 0, 0);
export const MINUTE = 60_000;

export interface World {
  readonly trace: Trace;
  readonly broker: Broker;
  readonly source: OrderService;
  readonly relay: OutboxRelay;
  readonly inventory: Consumer;
  readonly notifications: Consumer;
}

export interface WorldOptions {
  readonly strategy?: CaptureStrategy;
  readonly mutation?: ConsumerMutation;
  readonly enableOrdering?: boolean;
  readonly maxDeliveryAttempts?: number;
  readonly knownVersions?: readonly SchemaVersion[];
  readonly batchSize?: number;
}

export function buildWorld(options: WorldOptions = {}): World {
  const strategy = options.strategy ?? "outbox";
  const trace = new Trace();
  const broker = new Broker(trace);
  broker.createTopic(TOPIC);
  broker.createTopic(DEAD_LETTER);

  const source = new OrderService({ strategy, trace, broker, topic: TOPIC });

  for (const name of ["inventory-sub", "notify-sub"]) {
    broker.subscribe({
      name,
      topic: TOPIC,
      enableOrdering: options.enableOrdering ?? true,
      deadLetterTopic: DEAD_LETTER,
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? 5,
    });
  }

  const relay = new OutboxRelay(source, broker, trace, {
    name: "relay-a",
    batchSize: options.batchSize ?? 10,
    leaseMs: 30_000,
    topic: TOPIC,
  });

  const knownVersions = options.knownVersions ?? [1, 2];
  const inventory = new Consumer(broker, trace, {
    name: "inventory",
    subscription: "inventory-sub",
    knownVersions,
    handler: inventoryHandler,
    deadLetterTopic: DEAD_LETTER,
    mutation: options.mutation ?? "none",
  });
  const notifications = new Consumer(broker, trace, {
    name: "notifications",
    subscription: "notify-sub",
    knownVersions,
    handler: notificationHandler,
    deadLetterTopic: DEAD_LETTER,
    mutation: options.mutation ?? "none",
  });

  return { trace, broker, source, relay, inventory, notifications };
}

/** Everything an auditor could see: outbox rows plus anything that reached the topic. */
export function knownEvents(world: World): EventEnvelope[] {
  const seen = new Map<string, EventEnvelope>();
  for (const e of world.source.eventLog()) seen.set(e.eventId, e);
  for (const m of world.broker.publishedMessages(TOPIC)) seen.set(m.body.eventId, m.body);
  return [...seen.values()].sort(
    (a, b) => a.aggregateId.localeCompare(b.aggregateId) || a.sequence - b.sequence,
  );
}

export function audit(
  world: World,
  replayComparison?: { before: readonly string[]; after: readonly string[] },
): LineageReport {
  return verifyLineage({
    trace: world.trace,
    knownEvents: knownEvents(world),
    expectedConsumers: ["inventory", "notifications"],
    ...(replayComparison === undefined ? {} : { replayComparison }),
  });
}

export function effectIds(world: World): string[] {
  return [...world.inventory.effects.keys(), ...world.notifications.effects.keys()].sort();
}

/** Run a function, swallowing only an injected crash. A real error still fails the test. */
export function survivingCrash<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SimulatedCrash) return null;
    throw err;
  }
}

export interface CrashWindowResult {
  readonly strategy: CaptureStrategy;
  readonly crashAt: CrashPoint;
  readonly committed: number;
  readonly eventsOnTopic: number;
  readonly protectedEffects: number;
  readonly findings: readonly string[];
}

/**
 * One order, one injected crash, one restart, and then the system is allowed to
 * settle. The question each run answers is: after everything that can recover
 * has recovered, is the chain from committed change to consumer effect intact?
 */
export function crashWindow(strategy: CaptureStrategy, crashAt: CrashPoint): CrashWindowResult {
  const world = buildWorld({ strategy });
  const { source, relay, inventory, notifications } = world;

  survivingCrash(() =>
    source.confirm({
      orderId: "ord-100",
      operationId: "op-100",
      lines: [{ sku: "sku-a", quantity: 2 }],
      schemaVersion: 1,
      nowMs: T0,
      crashAt,
    }),
  );

  // Restart. Whatever the crash interrupted, the recovery path runs now.
  if (strategy === "outbox") {
    survivingCrash(() => relay.runOnce(T0 + MINUTE, crashAt));
    // A relay that died mid-batch left its lease behind; it expires and the
    // row is picked up again.
    survivingCrash(() => relay.drain(T0 + 2 * MINUTE));
  }

  inventory.drain(T0 + 3 * MINUTE);
  notifications.drain(T0 + 3 * MINUTE);

  const report = audit(world);
  return {
    strategy,
    crashAt,
    committed: world.trace.count("commit"),
    eventsOnTopic: world.broker.publishedMessages(TOPIC).length,
    protectedEffects: inventory.protectedEffectCount() + notifications.protectedEffectCount(),
    findings: report.findings.map((f) => f.code),
  };
}

/** The crash points worth comparing, in the order the article discusses them. */
export const CRASH_POINTS: readonly CrashPoint[] = [
  "none",
  "before-commit",
  "after-commit-before-publish",
  "after-publish-before-checkpoint",
];

export const STRATEGIES: readonly CaptureStrategy[] = [
  "outbox",
  "publish-after-commit",
  "publish-before-commit",
];
