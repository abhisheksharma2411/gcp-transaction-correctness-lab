// The event-lineage verifier. This is the module's contribution.
//
// Every other file here implements a mechanism. This one audits a *run* of
// those mechanisms and reports what the chain from business change to consumer
// effect is missing. It reads the trace and the event catalogue -- the records
// the system chose to write -- and nothing else, which is the same material an
// auditor would have.
//
// Ten findings, each with a code, because "the events look fine" is not a
// result anybody can act on.
//
//   L01  a committed change with no event
//   L02  an event with no committed change
//   L03  an event captured but never published
//   L04  an event published but never delivered to a consumer that needs it
//   L05  one protected effect applied twice
//   L06  a schema version nobody handled and nobody routed
//   L07  an effect with no delivery that could have caused it
//   L08  effects applied for one aggregate in decreasing sequence order
//   L09  a replay that changed the effect set
//   L10  a dead-lettered event with no repair
//
// Verify a quiesced system. Running the verifier while a relay still has rows
// to publish reports L03 for every one of them, correctly and uselessly.

import type { Trace } from "./trace.ts";
import type { EventEnvelope, Finding } from "./types.ts";

export interface LineageInput {
  readonly trace: Trace;
  /** Every event the auditor can see: outbox rows plus anything published. */
  readonly knownEvents: readonly EventEnvelope[];
  /** Consumers that are expected to receive every event on the main topic. */
  readonly expectedConsumers: readonly string[];
  /** Effect ids before and after a replay, when a replay was run. */
  readonly replayComparison?: { readonly before: readonly string[]; readonly after: readonly string[] };
}

export interface LineageReport {
  readonly findings: readonly Finding[];
  readonly checked: {
    readonly commits: number;
    readonly events: number;
    readonly publishes: number;
    readonly deliveries: number;
    readonly effects: number;
  };
}

export function verifyLineage(input: LineageInput): LineageReport {
  const { trace } = input;
  const findings: Finding[] = [];

  const byAggSeq = new Map<string, EventEnvelope>();
  const byId = new Map<string, EventEnvelope>();
  for (const e of input.knownEvents) {
    byAggSeq.set(`${e.aggregateId}#${e.sequence}`, e);
    byId.set(e.eventId, e);
  }

  const commits = trace.of("commit");
  const outboxWrites = trace.of("outbox-write");
  const publishes = trace.of("publish");
  const deliveries = trace.of("deliver");
  const effects = trace.of("effect");
  const deadLetters = trace.of("dead-letter");
  const repairs = trace.of("dead-letter-repair");
  const unhandled = trace.of("unhandled-version");
  const stale = trace.of("stale");
  const deferred = trace.of("deferred");

  // L01 -- a committed change with no event.
  for (const c of commits) {
    if (!byAggSeq.has(`${c.aggregateId}#${c.sequence}`)) {
      findings.push({
        code: "L01_MISSING_EVENT",
        severity: "high",
        detail: `committed ${c.aggregateId} sequence ${c.sequence} in ${c.txId} produced no event`,
        refs: [c.txId, c.aggregateId],
      });
    }
  }

  // L02 -- an event with no committed change.
  const committedKeys = new Set(commits.map((c) => `${c.aggregateId}#${c.sequence}`));
  for (const e of input.knownEvents) {
    if (!committedKeys.has(`${e.aggregateId}#${e.sequence}`)) {
      findings.push({
        code: "L02_PHANTOM_EVENT",
        severity: "high",
        detail: `event ${e.eventId} describes ${e.aggregateId} sequence ${e.sequence}, which never committed`,
        refs: [e.eventId, e.aggregateId],
      });
    }
  }

  // L03 -- captured but never published.
  const publishedIds = new Set(publishes.map((p) => p.eventId));
  for (const w of outboxWrites) {
    if (!publishedIds.has(w.eventId)) {
      findings.push({
        code: "L03_UNPUBLISHED",
        severity: "high",
        detail: `event ${w.eventId} was written to the outbox in ${w.txId} and never published`,
        refs: [w.eventId, w.txId],
      });
    }
  }

  // L04 -- published but never delivered to a consumer that needs it.
  const deadLetteredIds = new Set(deadLetters.map((d) => d.eventId));
  for (const eventId of publishedIds) {
    if (deadLetteredIds.has(eventId)) continue;
    const got = new Set(deliveries.filter((d) => d.eventId === eventId).map((d) => d.consumer));
    for (const consumer of input.expectedConsumers) {
      if (!got.has(consumer)) {
        findings.push({
          code: "L04_UNDELIVERED",
          severity: "medium",
          detail: `event ${eventId} was published but never delivered to ${consumer}`,
          refs: [eventId, consumer],
        });
      }
    }
  }

  // L05 -- one protected effect applied twice. The finding that matters most.
  const effectSeen = new Map<string, number>();
  for (const e of effects) effectSeen.set(e.effectId, (effectSeen.get(e.effectId) ?? 0) + 1);
  for (const [effectId, n] of [...effectSeen.entries()].sort()) {
    if (n > 1) {
      const sample = effects.find((e) => e.effectId === effectId)!;
      findings.push({
        code: "L05_DUPLICATE_PROTECTED_EFFECT",
        severity: "high",
        detail: `${sample.consumer} applied ${effectId} (${sample.effectKind}) ${n} times`,
        refs: [effectId, sample.consumer, sample.eventId],
      });
    }
  }

  // L06 -- a schema version nobody handled and nobody routed.
  for (const u of unhandled) {
    if (!u.routedToDeadLetter) {
      findings.push({
        code: "L06_UNHANDLED_SCHEMA_VERSION",
        severity: "high",
        detail: `${u.consumer} met schema version ${u.schemaVersion} on ${u.eventId} and neither handled nor routed it`,
        refs: [u.eventId, u.consumer],
      });
    }
  }

  // L07 -- an effect with no delivery that could have caused it.
  for (const e of effects) {
    const caused = deliveries.some(
      (d) => d.eventId === e.eventId && d.consumer === e.consumer && d.atMs <= e.atMs,
    );
    if (!caused) {
      findings.push({
        code: "L07_ORPHAN_EFFECT",
        severity: "medium",
        detail: `${e.consumer} applied ${e.effectId} with no prior delivery of ${e.eventId}`,
        refs: [e.effectId, e.consumer, e.eventId],
      });
    }
  }

  // L08 -- effects applied for one aggregate in decreasing sequence order.
  //
  // An out-of-order *delivery* is not a defect; the platform never promised
  // otherwise across ordering keys. An out-of-order *application* is, unless
  // the consumer said out loud that it noticed.
  const noticed = new Set([
    ...stale.map((s) => `${s.consumer}|${s.eventId}`),
    ...deferred.map((d) => `${d.consumer}|${d.eventId}`),
  ]);
  const lastSeq = new Map<string, number>();
  for (const e of effects) {
    const envelope = byId.get(e.eventId);
    if (envelope === undefined) continue;
    const key = `${e.consumer}|${envelope.aggregateId}`;
    const prev = lastSeq.get(key);
    if (prev !== undefined && envelope.sequence < prev && !noticed.has(`${e.consumer}|${e.eventId}`)) {
      findings.push({
        code: "L08_ORDER_VIOLATION",
        severity: "medium",
        detail: `${e.consumer} applied ${envelope.aggregateId} sequence ${envelope.sequence} after ${prev}`,
        refs: [e.eventId, e.consumer],
      });
    }
    lastSeq.set(key, Math.max(prev ?? 0, envelope.sequence));
  }

  // L09 -- a replay that changed the effect set.
  if (input.replayComparison !== undefined) {
    const before = [...input.replayComparison.before].sort();
    const after = [...input.replayComparison.after].sort();
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    if (added.length > 0 || removed.length > 0) {
      findings.push({
        code: "L09_REPLAY_DIVERGENCE",
        severity: "high",
        detail: `replay changed the effect set: ${added.length} added, ${removed.length} removed`,
        refs: [...added.slice(0, 3), ...removed.slice(0, 3)],
      });
    }
  }

  // L10 -- a dead-lettered event with no repair.
  const repaired = new Set(repairs.map((r) => r.eventId));
  for (const d of deadLetters) {
    if (!repaired.has(d.eventId)) {
      findings.push({
        code: "L10_DEAD_LETTER_UNRESOLVED",
        severity: "medium",
        detail: `event ${d.eventId} was dead-lettered from ${d.subscription} (${d.reason}) and never repaired`,
        refs: [d.eventId, d.subscription],
      });
    }
  }

  return {
    findings,
    checked: {
      commits: commits.length,
      events: input.knownEvents.length,
      publishes: publishes.length,
      deliveries: deliveries.length,
      effects: effects.length,
    },
  };
}

/** A compact, stable rendering for reports and for failing tests. */
export function formatFindings(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.code} [${f.severity}] ${f.detail}`);
}
