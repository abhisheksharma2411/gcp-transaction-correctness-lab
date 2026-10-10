// A Pub/Sub-compatible local adapter.
//
// "Compatible" means the behaviours a correctness argument depends on, not the
// API surface. Specifically it reproduces:
//
//   - at-least-once delivery, with redelivery after a failed acknowledgement;
//   - publish-side duplicates carrying *different* message ids for one event;
//   - ordering within an ordering key, and no ordering across keys;
//   - redelivery of a message dragging later messages for that key with it;
//   - a delivery-attempt counter, and dead-letter forwarding when it is spent;
//   - seek, which replays acknowledged messages and resets delivery attempts.
//
// It is a model. ../docs/MODEL.md lists every place it is not the real thing.

import type { Trace } from "./trace.ts";
import type { BrokerMessage, EventEnvelope } from "./types.ts";

export interface SubscriptionConfig {
  readonly name: string;
  readonly topic: string;
  /** Ordered delivery within an ordering key. */
  readonly enableOrdering: boolean;
  /** Where a message goes when its delivery attempts are spent. */
  readonly deadLetterTopic: string | null;
  /** Pub/Sub's minimum is 5 and its maximum is 100. The model enforces the same floor. */
  readonly maxDeliveryAttempts: number;
}

interface SubMessageState {
  readonly message: BrokerMessage;
  acked: boolean;
  outstanding: boolean;
  deliveryAttempt: number;
  deadLettered: boolean;
}

export class Broker {
  private readonly topics = new Map<string, BrokerMessage[]>();
  private readonly subs = new Map<string, { config: SubscriptionConfig; state: SubMessageState[] }>();
  private readonly trace: Trace;
  private publishCounter = 0;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  createTopic(name: string): void {
    if (!this.topics.has(name)) this.topics.set(name, []);
  }

  subscribe(config: SubscriptionConfig): void {
    if (config.maxDeliveryAttempts < 5) {
      // The documented minimum. Modelling a smaller value would make the
      // dead-letter tests pass for a reason the platform would not allow.
      throw new Error("maxDeliveryAttempts must be at least 5");
    }
    this.createTopic(config.topic);
    if (config.deadLetterTopic !== null) this.createTopic(config.deadLetterTopic);
    // A subscription created now does not see what was published before it.
    // Backfilling a new consumer is therefore a replay problem, solved against
    // the event log, not a subscription problem solved against the topic.
    this.subs.set(config.name, { config, state: [] });
  }

  /**
   * Publish one event.
   *
   * Each call mints a new message id. That is the modelled form of a
   * publish-side duplicate: one event, two messages, two ids, and no
   * message-id-keyed de-duplication anywhere that can tell they are the same.
   */
  publish(topic: string, body: EventEnvelope, nowMs: number, publisher: string): BrokerMessage {
    this.createTopic(topic);
    const message: BrokerMessage = {
      messageId: `msg-${String(++this.publishCounter).padStart(4, "0")}`,
      topic,
      orderingKey: `${body.aggregateType}:${body.aggregateId}`,
      publishTimeMs: nowMs,
      body,
      deliveryAttempt: 0,
      deadLetteredFrom: null,
    };
    this.topics.get(topic)!.push(message);
    for (const sub of this.subs.values()) {
      if (sub.config.topic === topic) sub.state.push(this.freshState(message));
    }
    this.trace.record({
      kind: "publish",
      atMs: nowMs,
      eventId: body.eventId,
      messageId: message.messageId,
      relay: publisher,
      attempt: this.countPublishesOf(topic, body.eventId),
    });
    return message;
  }

  /**
   * Pull up to `max` deliverable messages.
   *
   * With ordering enabled, at most one message per ordering key is outstanding
   * at a time, which is what makes in-order processing possible and what makes
   * a slow key block its own queue.
   */
  pull(subscription: string, max: number, nowMs: number, consumer: string): BrokerMessage[] {
    const sub = this.require(subscription);
    const out: BrokerMessage[] = [];
    const keysInFlight = new Set(
      sub.state.filter((s) => s.outstanding).map((s) => s.message.orderingKey),
    );
    for (const s of sub.state) {
      if (out.length >= max) break;
      if (s.acked || s.outstanding || s.deadLettered) continue;
      if (sub.config.enableOrdering) {
        if (keysInFlight.has(s.message.orderingKey)) continue;
        keysInFlight.add(s.message.orderingKey);
      }
      s.outstanding = true;
      s.deliveryAttempt += 1;
      const delivered: BrokerMessage = { ...s.message, deliveryAttempt: s.deliveryAttempt };
      out.push(delivered);
      this.trace.record({
        kind: "deliver",
        atMs: nowMs,
        messageId: delivered.messageId,
        eventId: delivered.body.eventId,
        consumer,
        deliveryAttempt: s.deliveryAttempt,
      });
    }
    return out;
  }

  ack(subscription: string, messageId: string, nowMs: number, consumer: string): void {
    const s = this.find(subscription, messageId);
    s.outstanding = false;
    s.acked = true;
    this.trace.record({ kind: "ack", atMs: nowMs, consumer, messageId });
  }

  /**
   * The acknowledgement was sent and did not stick.
   *
   * This is the window Pub/Sub's own documentation points at: a failed
   * acknowledgement produces a redelivery, and the effect has already happened.
   */
  loseAck(subscription: string, messageId: string, nowMs: number, consumer: string): void {
    const s = this.find(subscription, messageId);
    s.outstanding = false;
    s.acked = false;
    this.trace.record({ kind: "ack-lost", atMs: nowMs, consumer, messageId });
    this.cascadeRedelivery(subscription, s);
  }

  /** Negative acknowledgement, or a deadline that expired. Counts against the delivery budget. */
  nack(subscription: string, messageId: string, nowMs: number, consumer: string, reason: string): void {
    const sub = this.require(subscription);
    const s = this.find(subscription, messageId);
    s.outstanding = false;
    this.trace.record({ kind: "nack", atMs: nowMs, consumer, messageId, reason });
    if (sub.config.deadLetterTopic !== null && s.deliveryAttempt >= sub.config.maxDeliveryAttempts) {
      s.deadLettered = true;
      const forwarded = this.publish(sub.config.deadLetterTopic, s.message.body, nowMs, "dead-letter");
      void forwarded;
      this.trace.record({
        kind: "dead-letter",
        atMs: nowMs,
        messageId,
        eventId: s.message.body.eventId,
        subscription,
        reason,
      });
      return;
    }
    this.cascadeRedelivery(subscription, s);
  }

  /**
   * Seek to a timestamp: everything published at or after it becomes unacked.
   *
   * Two modelled consequences matter more than the replay itself. Delivery
   * attempts reset to zero, so a message that was one nack away from the
   * dead-letter topic gets its whole budget back. And the subscription has no
   * memory that this is a replay, so every guard downstream has to be the thing
   * that notices.
   */
  seek(subscription: string, toMs: number, nowMs: number): number {
    const sub = this.require(subscription);
    let n = 0;
    for (const s of sub.state) {
      if (s.message.publishTimeMs >= toMs && !s.deadLettered) {
        s.acked = false;
        s.outstanding = false;
        s.deliveryAttempt = 0;
        n += 1;
      }
    }
    void nowMs;
    return n;
  }

  /** Messages sitting in a dead-letter topic, for a repair tool to read. */
  deadLetterContents(topic: string): BrokerMessage[] {
    return [...(this.topics.get(topic) ?? [])];
  }

  backlog(subscription: string): number {
    const sub = this.require(subscription);
    return sub.state.filter((s) => !s.acked && !s.deadLettered).length;
  }

  publishedMessages(topic: string): BrokerMessage[] {
    return [...(this.topics.get(topic) ?? [])];
  }

  /**
   * Ordered subscriptions redeliver *forward*.
   *
   * When one message for a key comes back, the messages after it for that key
   * come back too, acknowledged or not. A consumer that treats an
   * acknowledgement as "this will never return" is wrong in exactly this case.
   */
  private cascadeRedelivery(subscription: string, from: SubMessageState): void {
    const sub = this.require(subscription);
    if (!sub.config.enableOrdering) return;
    let seen = false;
    for (const s of sub.state) {
      if (s === from) {
        seen = true;
        continue;
      }
      if (!seen) continue;
      if (s.message.orderingKey !== from.message.orderingKey) continue;
      if (s.deadLettered) continue;
      s.acked = false;
      s.outstanding = false;
    }
  }

  private freshState(message: BrokerMessage): SubMessageState {
    return { message, acked: false, outstanding: false, deliveryAttempt: 0, deadLettered: false };
  }

  private countPublishesOf(topic: string, eventId: string): number {
    return (this.topics.get(topic) ?? []).filter((m) => m.body.eventId === eventId).length;
  }

  private require(name: string): { config: SubscriptionConfig; state: SubMessageState[] } {
    const sub = this.subs.get(name);
    if (sub === undefined) throw new Error(`no subscription ${name}`);
    return sub;
  }

  private find(subscription: string, messageId: string): SubMessageState {
    const sub = this.require(subscription);
    const s = sub.state.find((x) => x.message.messageId === messageId);
    if (s === undefined) throw new Error(`no message ${messageId} on ${subscription}`);
    return s;
  }
}
