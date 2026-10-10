// The consumer: inbox, effect ledger, sequence handling, schema versions.
//
// The division of labour is the point. The broker decides what gets delivered.
// The consumer decides what gets *done*, and those are different questions with
// different answers. Everything in this file exists because the second question
// cannot be delegated to the first.

import { deriveEffectId } from "./identity.ts";
import { SimulatedCrash } from "./source.ts";
import type { Broker } from "./broker.ts";
import type { Trace } from "./trace.ts";
import type { BrokerMessage, EffectRecord, EventEnvelope, InboxRow, SchemaVersion } from "./types.ts";

/** A single externally visible action the handler wants to take. */
export interface PlannedEffect {
  readonly kind: string;
  readonly subject: string;
}

export type Handler = (envelope: EventEnvelope) => PlannedEffect[];

/** Deliberate weakenings, each of which must turn specific named tests red. */
export type ConsumerMutation =
  | "none"
  | "no-inbox"
  | "no-effect-ledger"
  | "no-sequence-guard"
  /** No message-level de-duplication at all: no inbox, no sequence position. */
  | "no-message-dedup"
  /** Every guard removed. Nothing is left but hope. */
  | "no-guards"
  | "ignore-schema-version";

export const CONSUMER_MUTATIONS: readonly ConsumerMutation[] = [
  "no-inbox",
  "no-sequence-guard",
  "no-effect-ledger",
  "no-message-dedup",
  "no-guards",
  "ignore-schema-version",
];

export type HandleOutcome =
  | "APPLIED"
  | "INBOX_HIT"
  | "DEFERRED"
  | "STALE"
  | "UNKNOWN_VERSION"
  | "POISON";

export interface ConsumerOptions {
  readonly name: string;
  readonly subscription: string;
  readonly knownVersions: readonly SchemaVersion[];
  readonly handler: Handler;
  readonly deadLetterTopic: string | null;
  readonly mutation?: ConsumerMutation;
}

export class Consumer {
  readonly name: string;
  readonly subscription: string;
  readonly inbox = new Map<string, InboxRow>();
  readonly effects = new Map<string, EffectRecord>();
  /** Highest aggregate sequence applied, per aggregate. */
  readonly highWater = new Map<string, number>();
  /** Events that arrived before their predecessor, held rather than applied. */
  readonly deferred = new Map<string, EventEnvelope>();
  suppressedByInbox = 0;
  suppressedByEffectLedger = 0;
  /**
   * How many times an effect was *applied*, which is not the same as how many
   * distinct effects exist. A correct run makes those two numbers equal; that
   * they can differ is the whole subject.
   */
  effectApplications = 0;

  private readonly options: ConsumerOptions;
  private readonly broker: Broker;
  private readonly trace: Trace;
  private readonly mutation: ConsumerMutation;
  private readonly inboxEnabled: boolean;
  private readonly sequenceGuardEnabled: boolean;
  private readonly effectLedgerEnabled: boolean;

  constructor(broker: Broker, trace: Trace, options: ConsumerOptions) {
    this.broker = broker;
    this.trace = trace;
    this.options = options;
    this.name = options.name;
    this.subscription = options.subscription;
    this.mutation = options.mutation ?? "none";
    const off = (...ms: ConsumerMutation[]) => ms.includes(this.mutation);
    this.inboxEnabled = !off("no-inbox", "no-message-dedup", "no-guards");
    this.sequenceGuardEnabled = !off("no-sequence-guard", "no-message-dedup", "no-guards");
    this.effectLedgerEnabled = !off("no-effect-ledger", "no-guards");
  }

  /**
   * Handle one delivered message.
   *
   * The order of the guards below is the consumer's contract:
   *
   *   1. a version this code does not understand is routed, never dropped;
   *   2. a message already in the inbox is acknowledged and does nothing;
   *   3. an event out of sequence is held, not applied;
   *   4. a handler that throws is negatively acknowledged, not swallowed;
   *   5. the effect and the inbox row are written together.
   */
  handle(
    message: BrokerMessage,
    nowMs: number,
    opts: { crashAfterEffectBeforeAck?: boolean; loseAck?: boolean } = {},
  ): HandleOutcome {
    const envelope = message.body;

    // 1. Schema version.
    const known = this.options.knownVersions.includes(envelope.schemaVersion);
    if (!known && this.mutation !== "ignore-schema-version") {
      // Routed, not dropped, and not acknowledged into oblivion. An unknown
      // version is a deployment-ordering problem, and the only honest response
      // is to put the message somewhere a human can find it.
      this.trace.record({
        kind: "unhandled-version",
        atMs: nowMs,
        consumer: this.name,
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        routedToDeadLetter: this.options.deadLetterTopic !== null,
      });
      if (this.options.deadLetterTopic !== null) {
        this.broker.publish(this.options.deadLetterTopic, envelope, nowMs, `${this.name}:unknown-version`);
        this.trace.record({
          kind: "dead-letter",
          atMs: nowMs,
          messageId: message.messageId,
          eventId: envelope.eventId,
          subscription: this.subscription,
          reason: `unknown schema version ${envelope.schemaVersion}`,
        });
      }
      this.broker.ack(this.subscription, message.messageId, nowMs, this.name);
      return "UNKNOWN_VERSION";
    }
    if (!known && this.mutation === "ignore-schema-version") {
      // The mutation: carry on as though the version were understood. This is
      // what "just ignore the fields you do not know" becomes when the unknown
      // part is the part that changed the meaning.
      this.trace.record({
        kind: "unhandled-version",
        atMs: nowMs,
        consumer: this.name,
        eventId: envelope.eventId,
        schemaVersion: envelope.schemaVersion,
        routedToDeadLetter: false,
      });
    }

    // 2. Inbox.
    if (this.inboxEnabled && this.inbox.has(this.inboxKey(envelope.eventId))) {
      this.suppressedByInbox += 1;
      this.trace.record({ kind: "inbox-hit", atMs: nowMs, consumer: this.name, eventId: envelope.eventId });
      this.broker.ack(this.subscription, message.messageId, nowMs, this.name);
      return "INBOX_HIT";
    }

    // 3. Sequence.
    if (this.sequenceGuardEnabled) {
      const hw = this.highWater.get(envelope.aggregateId) ?? 0;
      if (envelope.sequence <= hw) {
        // Already superseded. Acknowledging is right; applying is not.
        this.trace.record({ kind: "stale", atMs: nowMs, consumer: this.name, eventId: envelope.eventId, highWater: hw });
        this.broker.ack(this.subscription, message.messageId, nowMs, this.name);
        return "STALE";
      }
      if (envelope.sequence > hw + 1) {
        // A gap. Holding the event is the only answer that keeps the aggregate's
        // history meaningful; applying it would make the projection depend on
        // delivery order, which is not a property anyone controls.
        this.deferred.set(envelope.eventId, envelope);
        this.trace.record({
          kind: "deferred",
          atMs: nowMs,
          consumer: this.name,
          eventId: envelope.eventId,
          expected: hw + 1,
          got: envelope.sequence,
        });
        this.broker.nack(this.subscription, message.messageId, nowMs, this.name, "sequence gap");
        return "DEFERRED";
      }
    }

    // 4. The handler.
    let planned: PlannedEffect[];
    try {
      planned = this.options.handler(envelope);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.broker.nack(this.subscription, message.messageId, nowMs, this.name, reason);
      return "POISON";
    }

    // 5. The effect and the inbox row, written together.
    const appliedIds: string[] = [];
    for (const p of planned) {
      const effectId = deriveEffectId(this.name, envelope, p.kind, p.subject);
      if (this.effectLedgerEnabled && this.effects.has(effectId)) {
        this.suppressedByEffectLedger += 1;
        this.trace.record({
          kind: "effect-suppressed",
          atMs: nowMs,
          consumer: this.name,
          effectId,
          eventId: envelope.eventId,
        });
        continue;
      }
      this.effects.set(effectId, {
        effectId,
        consumer: this.name,
        kind: p.kind,
        subject: p.subject,
        eventId: envelope.eventId,
        appliedAtMs: nowMs,
      });
      appliedIds.push(effectId);
      this.effectApplications += 1;
      this.trace.record({
        kind: "effect",
        atMs: nowMs,
        consumer: this.name,
        effectId,
        eventId: envelope.eventId,
        effectKind: p.kind,
      });
    }
    if (this.inboxEnabled) {
      this.inbox.set(this.inboxKey(envelope.eventId), {
        consumer: this.name,
        eventId: envelope.eventId,
        processedAtMs: nowMs,
        effectIds: appliedIds,
      });
    }
    this.highWater.set(
      envelope.aggregateId,
      Math.max(this.highWater.get(envelope.aggregateId) ?? 0, envelope.sequence),
    );

    if (opts.crashAfterEffectBeforeAck === true) {
      this.trace.record({
        kind: "crash",
        atMs: nowMs,
        component: `consumer:${this.name}`,
        at: "after-effect-before-ack",
      });
      throw new SimulatedCrash(`consumer:${this.name}`, "after-effect-before-ack");
    }
    if (opts.loseAck === true) {
      this.broker.loseAck(this.subscription, message.messageId, nowMs, this.name);
      return "APPLIED";
    }

    this.broker.ack(this.subscription, message.messageId, nowMs, this.name);
    return "APPLIED";
  }

  /**
   * Apply an effect without a delivery: an operator running a fix-up script.
   *
   * This exists because it happens, and because an audit that cannot see it is
   * worse than no audit. The verifier reports every effect with no delivery
   * behind it as L07, which is not an accusation -- it is a question somebody
   * should be able to answer.
   */
  applyManually(envelope: EventEnvelope, nowMs: number): string[] {
    const applied: string[] = [];
    for (const p of this.options.handler(envelope)) {
      const effectId = deriveEffectId(this.name, envelope, p.kind, p.subject);
      if (this.effectLedgerEnabled && this.effects.has(effectId)) continue;
      this.effects.set(effectId, {
        effectId, consumer: this.name, kind: p.kind, subject: p.subject,
        eventId: envelope.eventId, appliedAtMs: nowMs,
      });
      this.effectApplications += 1;
      applied.push(effectId);
      this.trace.record({
        kind: "effect", atMs: nowMs, consumer: this.name,
        effectId, eventId: envelope.eventId, effectKind: p.kind,
      });
    }
    return applied;
  }

  /** Pull and handle until nothing more is deliverable, with a bound. */
  drain(nowMs: number, maxRounds = 60, batch = 4): HandleOutcome[] {
    const outcomes: HandleOutcome[] = [];
    for (let i = 0; i < maxRounds; i += 1) {
      const messages = this.broker.pull(this.subscription, batch, nowMs + i, this.name);
      if (messages.length === 0) break;
      let progressed = false;
      for (const m of messages) {
        const outcome = this.handle(m, nowMs + i);
        outcomes.push(outcome);
        if (outcome !== "DEFERRED" && outcome !== "POISON") progressed = true;
      }
      if (!progressed && this.broker.backlog(this.subscription) > 0 && i > maxRounds - 2) break;
    }
    return outcomes;
  }

  /** Distinct protected effects. */
  protectedEffectCount(): number {
    return this.effects.size;
  }

  private inboxKey(eventId: string): string {
    return `${this.name}|${eventId}`;
  }
}

/** The inventory consumer: one reservation per order line. */
export function inventoryHandler(envelope: EventEnvelope): PlannedEffect[] {
  const lines = (envelope.payload["lines"] ?? []) as { sku: string; quantity: number }[];
  for (const line of lines) {
    if (line.quantity <= 0) {
      // A poison event: schema-valid, business-invalid. Retrying will not fix
      // it, and no number of delivery attempts will make the quantity positive.
      throw new Error(`non-positive quantity for ${line.sku}`);
    }
  }
  return lines.map((line) => ({ kind: "reserve", subject: line.sku }));
}

/** The notification consumer: one message per order, whatever the lines say. */
export function notificationHandler(envelope: EventEnvelope): PlannedEffect[] {
  return [{ kind: "notify", subject: envelope.aggregateId }];
}
