// Negative controls.
//
// The verifier reported zero findings on the first correct run it was pointed
// at, which proves nothing: the same hand wrote the mechanisms and the checks.
// So every finding code has to be *provoked* by a specific, named defect, and
// the control is required to produce that code and no more than its stated set.
//
// A control that reddens everything is rejected too. "I broke the system and
// the checker complained" is not evidence that any particular check does work.

import { makeEnvelope } from "./identity.ts";
import { applyReplay, planReplay } from "./replay.ts";
import { DEAD_LETTER, MINUTE, T0, TOPIC, audit, buildWorld, effectIds, survivingCrash } from "./scenarios.ts";
import type { ConsumerMutation } from "./consumer.ts";
import type { World } from "./scenarios.ts";
import type { CaptureStrategy } from "./source.ts";
import type { FindingCode } from "./types.ts";

const DAY = 86_400_000;

export interface RunOptions {
  readonly strategy?: CaptureStrategy;
  readonly mutation?: ConsumerMutation;
  /** Skip the relay entirely, as a stalled or unstarted relay would. */
  readonly skipRelay?: boolean;
  /** Leave dead-lettered events unrepaired. */
  readonly skipRepair?: boolean;
  /** Crash the source after it commits and before it publishes. */
  readonly crashSource?: boolean;
  /** Crash the relay after it publishes and before it checkpoints. */
  readonly crashRelay?: boolean;
  /** Deliver one aggregate's events in the wrong order. */
  readonly misorder?: boolean;
  readonly enableOrdering?: boolean;
  /** Leave one consumer's subscription undrained. */
  readonly skipConsumer?: "inventory" | "notifications";
  /** An operator applies an effect by hand, with no delivery behind it. */
  readonly manualRepair?: boolean;
}

export interface RunResult {
  readonly world: World;
  readonly codes: readonly FindingCode[];
  readonly detail: readonly string[];
  readonly protectedEffects: number;
  readonly effectApplications: number;
}

/**
 * The standard run.
 *
 * Three orders, one of them changed twice. One poison event. One event at a
 * schema version the consumers do not know. A relay that dies mid-batch. A
 * replay of a historical range afterwards. It is meant to contain every
 * mechanism at once, because a verifier that is only ever pointed at one
 * mechanism at a time is not verifying lineage.
 */
export function standardRun(options: RunOptions = {}): RunResult {
  const world = buildWorld({
    strategy: options.strategy ?? "outbox",
    ...(options.mutation === undefined ? {} : { mutation: options.mutation }),
    enableOrdering: options.enableOrdering ?? !(options.misorder ?? false),
  });
  const { source, relay, inventory, notifications, broker, trace } = world;

  const confirm = (orderId: string, atMs: number, lines: { sku: string; quantity: number }[], version: 1 | 2 | 3) =>
    survivingCrash(() =>
      source.confirm({
        orderId,
        operationId: `op-${orderId}-${atMs}`,
        lines,
        schemaVersion: version,
        nowMs: atMs,
        crashAt:
          options.crashSource !== true || orderId !== "ord-a"
            ? "none"
            : (options.strategy ?? "outbox") === "publish-before-commit"
              // The phantom needs the crash on the other side of the publish.
              ? "before-commit"
              : "after-commit-before-publish",
      }),
    );

  confirm("ord-a", T0, [{ sku: "sku-1", quantity: 2 }], 1);
  confirm("ord-b", T0 + DAY, [{ sku: "sku-2", quantity: 1 }], 1);
  confirm("ord-b", T0 + DAY + 1, [{ sku: "sku-3", quantity: 4 }], 1);
  confirm("ord-c", T0 + 2 * DAY, [{ sku: "sku-4", quantity: 0 }], 1); // poison: quantity 0
  confirm("ord-d", T0 + 2 * DAY + 1, [{ sku: "sku-5", quantity: 1 }], 3); // a version nobody knows

  if (options.skipRelay !== true) {
    if (options.crashRelay === true) {
      survivingCrash(() => relay.runOnce(T0 + 3 * DAY, "after-publish-before-checkpoint"));
    }
    if (options.misorder === true) {
      // Publish ord-b's two events in the wrong order, by hand.
      const log = source.eventLog().filter((e) => e.aggregateId === "ord-b");
      broker.publish(TOPIC, log[1]!, T0 + 3 * DAY, "misordered");
      broker.publish(TOPIC, log[0]!, T0 + 3 * DAY + 1, "misordered");
      for (const row of source.claimable(T0 + 3 * DAY)) {
        if (row.envelope.aggregateId === "ord-b") row.publishedAtMs = T0 + 3 * DAY;
      }
    }
    relay.drain(T0 + 3 * DAY + 2);
  }

  if (options.skipConsumer !== "inventory") inventory.drain(T0 + 4 * DAY);
  if (options.skipConsumer !== "notifications") notifications.drain(T0 + 4 * DAY);

  if (options.manualRepair === true) {
    // An operator writes a correction by hand, for an order that no event in
    // the log describes. The effect is real; the lineage behind it is not.
    inventory.applyManually(
      makeEnvelope({
        aggregateType: "order",
        aggregateId: "ord-typed-by-hand",
        sequence: 1,
        eventType: "OrderConfirmed",
        schemaVersion: 1,
        recordedAtMs: T0 + 4 * DAY,
        operationId: "op-manual",
        payload: { lines: [{ sku: "sku-9", quantity: 1 }] },
      }),
      T0 + 4 * DAY + 1,
    );
  }

  if (options.skipRepair !== true) {
    // The operator reads the dead-letter topic and records what was done about
    // each event. Repair is a decision a human makes; the verifier only insists
    // that one was made and written down.
    for (const message of broker.deadLetterContents(DEAD_LETTER)) {
      trace.record({
        kind: "dead-letter-repair",
        atMs: T0 + 5 * DAY,
        eventId: message.body.eventId,
        action: message.body.schemaVersion === 3 ? "held for consumer upgrade" : "quantity corrected at source",
      });
    }
  }

  const before = effectIds(world);
  const plan = planReplay(source.eventLog(), { aggregateId: "ord-b", maxEvents: 50 }, "ctl");
  applyReplay(plan, broker, TOPIC, T0 + 6 * DAY, trace);
  if (options.skipConsumer !== "inventory") inventory.drain(T0 + 6 * DAY + MINUTE);
  if (options.skipConsumer !== "notifications") notifications.drain(T0 + 6 * DAY + MINUTE);
  const after = effectIds(world);

  const report = audit(world, { before, after });
  return {
    world,
    codes: report.findings.map((f) => f.code),
    detail: report.findings.map((f) => `${f.code}: ${f.detail}`),
    protectedEffects: inventory.protectedEffectCount() + notifications.protectedEffectCount(),
    effectApplications: inventory.effectApplications + notifications.effectApplications,
  };
}

export interface Control {
  readonly name: string;
  readonly defect: string;
  readonly options: RunOptions;
  /** The distinct codes this control must produce. */
  readonly expect: readonly FindingCode[];
  /** A control deliberately too blunt to be evidence. The suite must reject it. */
  readonly mustBeRejected?: boolean;
}

export const CONTROLS: readonly Control[] = [
  {
    name: "publish-after-commit",
    defect: "the event is published after the commit instead of with it",
    options: { strategy: "publish-after-commit", crashSource: true },
    expect: ["L01_MISSING_EVENT"],
  },
  {
    name: "publish-before-commit",
    defect: "the event is published before the commit, and the commit does not happen",
    options: { strategy: "publish-before-commit", crashSource: true },
    expect: ["L02_PHANTOM_EVENT"],
  },
  {
    name: "relay-never-runs",
    defect: "the outbox is written and nothing drains it",
    options: { skipRelay: true },
    // The replay then publishes those events for the first time, which changes
    // the effect set. The cascade is real and the control names it rather than
    // filtering it out.
    expect: ["L03_UNPUBLISHED", "L09_REPLAY_DIVERGENCE"],
  },
  {
    name: "no-guards",
    defect: "the consumer has no inbox, no sequence position and no effect ledger",
    options: { mutation: "no-guards" },
    // Re-applying an aggregate's earlier sequence is also an ordering
    // violation, so both codes are expected.
    expect: ["L05_DUPLICATE_PROTECTED_EFFECT", "L08_ORDER_VIOLATION"],
  },
  {
    name: "ignore-schema-version",
    defect: "an unknown schema version is treated as though it were understood",
    options: { mutation: "ignore-schema-version" },
    expect: ["L06_UNHANDLED_SCHEMA_VERSION"],
  },
  {
    name: "no-sequence-guard",
    defect: "events are applied in the order they arrive",
    options: { mutation: "no-sequence-guard", misorder: true },
    expect: ["L08_ORDER_VIOLATION"],
  },
  {
    name: "no-dead-letter-repair",
    defect: "events reach the dead-letter topic and nobody records what was done",
    options: { skipRepair: true },
    expect: ["L10_DEAD_LETTER_UNRESOLVED"],
  },
  {
    name: "consumer-never-drains",
    defect: "one consumer's subscription is never read",
    options: { skipConsumer: "notifications" },
    expect: ["L04_UNDELIVERED"],
  },
  {
    name: "manual-repair-off-the-record",
    defect: "an operator applies an effect by hand, with no delivery behind it",
    options: { manualRepair: true },
    expect: ["L07_ORPHAN_EFFECT"],
  },
  {
    name: "everything-at-once",
    defect: "no guards, misordered publication, a crashed relay and no repair, all at once",
    options: { mutation: "no-guards", misorder: true, skipRepair: true, crashRelay: true },
    expect: [],
    mustBeRejected: true,
  },
];

export interface ControlResult {
  readonly name: string;
  readonly defect: string;
  readonly expected: readonly FindingCode[];
  readonly produced: readonly FindingCode[];
  readonly detected: boolean;
  readonly blunt: boolean;
  readonly mustBeRejected: boolean;
}

export function runControls(): ControlResult[] {
  return CONTROLS.map((control) => {
    const produced = [...new Set(standardRun(control.options).codes)].sort();
    const expected = [...control.expect].sort();
    return {
      name: control.name,
      defect: control.defect,
      expected,
      produced,
      detected: expected.length > 0 && expected.every((c) => produced.includes(c)),
      mustBeRejected: control.mustBeRejected === true,
      // More than twice the expected number of distinct codes means the defect
      // is too blunt to show which check is doing the work.
      blunt: produced.length > Math.max(2, expected.length * 2),
    };
  });
}
