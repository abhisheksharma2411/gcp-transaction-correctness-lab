// Replay: putting old events back on the topic on purpose.
//
// Two decisions are baked in here and both are arguable, which is why they are
// in an ADR rather than only in a comment.
//
// Replay reads the **event log**, not the broker. A subscription only receives
// what was published after it was created, and a topic's retention is bounded,
// so a broker is the wrong place to ask for history. The outbox table is a
// record of what happened; the topic is a record of what was recently said.
//
// Replay is **bounded by construction**. A scope with no aggregate and no time
// range is refused rather than defaulted, because the default would be
// "everything", and the one certain thing about a replay is that it is being
// run by somebody having a bad day.

import type { Broker } from "./broker.ts";
import type { Trace } from "./trace.ts";
import type { EventEnvelope } from "./types.ts";

export interface ReplayScope {
  readonly aggregateId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly eventTypes?: readonly string[];
  /** Hard ceiling. There is no "unlimited". */
  readonly maxEvents: number;
}

export interface ReplayPlan {
  readonly batchId: string;
  readonly eventIds: readonly string[];
  readonly envelopes: readonly EventEnvelope[];
  /** True when the scope matched more events than `maxEvents` allowed. */
  readonly truncated: boolean;
  readonly scope: ReplayScope;
}

export class UnboundedReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnboundedReplayError";
  }
}

/**
 * Work out what a replay would do. This function publishes nothing.
 *
 * `--dry-run` in the CLI is this function and no more, which is the only way a
 * dry run is worth anything: if the plan and the execution are different code
 * paths, the dry run is a second implementation that can disagree with the
 * first.
 */
export function planReplay(
  events: readonly EventEnvelope[],
  scope: ReplayScope,
  batchId: string,
): ReplayPlan {
  if (scope.maxEvents <= 0) {
    throw new UnboundedReplayError("maxEvents must be positive");
  }
  const hasAggregate = scope.aggregateId !== undefined;
  const hasWindow = scope.fromMs !== undefined || scope.toMs !== undefined;
  if (!hasAggregate && !hasWindow) {
    throw new UnboundedReplayError(
      "replay scope needs an aggregate or a time window; refusing to replay everything",
    );
  }

  const matched = events
    .filter((e) => scope.aggregateId === undefined || e.aggregateId === scope.aggregateId)
    .filter((e) => scope.fromMs === undefined || e.recordedAtMs >= scope.fromMs)
    .filter((e) => scope.toMs === undefined || e.recordedAtMs <= scope.toMs)
    .filter((e) => scope.eventTypes === undefined || scope.eventTypes.includes(e.eventType))
    // Replaying an aggregate out of sequence order would create the
    // out-of-order case on purpose. The consumer would survive it; there is no
    // reason to make it prove that during a recovery.
    .sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.sequence - b.sequence);

  const selected = matched.slice(0, scope.maxEvents);
  return {
    batchId,
    eventIds: selected.map((e) => e.eventId),
    envelopes: selected,
    truncated: matched.length > selected.length,
    scope,
  };
}

/** Publish a plan. The envelopes are the originals: same event ids, same sequences. */
export function applyReplay(
  plan: ReplayPlan,
  broker: Broker,
  topic: string,
  nowMs: number,
  trace: Trace,
): number {
  trace.record({
    kind: "replay-plan",
    atMs: nowMs,
    batchId: plan.batchId,
    eventIds: plan.eventIds,
    dryRun: false,
  });
  let n = 0;
  for (const envelope of plan.envelopes) {
    broker.publish(topic, envelope, nowMs + n, `replay:${plan.batchId}`);
    trace.record({ kind: "replay-publish", atMs: nowMs + n, batchId: plan.batchId, eventId: envelope.eventId });
    n += 1;
  }
  return n;
}

/** Record a dry run in the trace without publishing anything. */
export function recordDryRun(plan: ReplayPlan, nowMs: number, trace: Trace): ReplayPlan {
  trace.record({
    kind: "replay-plan",
    atMs: nowMs,
    batchId: plan.batchId,
    eventIds: plan.eventIds,
    dryRun: true,
  });
  return plan;
}
