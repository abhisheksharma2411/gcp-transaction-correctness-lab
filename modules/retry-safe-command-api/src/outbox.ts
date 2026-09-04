import { TABLES, type TransactionalStore } from "./store.ts";
import type { LedgerEntry, OutboxRecord } from "./types.ts";
import type { Clock } from "./clock.ts";

export interface BusMessage {
  messageId: string;
  effectId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Increments on every redelivery, so tests can prove dedup, not luck. */
  deliveryAttempt: number;
}

/**
 * Stands in for a Pub/Sub topic and subscription.
 *
 * It is deliberately at-least-once. Pub/Sub's exactly-once delivery feature
 * removes redelivery after a successful acknowledgment within one region for
 * pull subscriptions, but it does not remove publish-side duplicates, and it
 * says nothing about whether the consumer's own side effect ran twice. The
 * consumer below therefore deduplicates on effect identity regardless.
 */
export class MessageBus {
  private published: BusMessage[] = [];
  private deliveredCount = 0;

  publish(message: Omit<BusMessage, "deliveryAttempt">): void {
    this.published.push({ ...message, deliveryAttempt: 1 });
  }

  /** Deliver every message that has not yet been handed to the consumer. */
  drain(): BusMessage[] {
    const batch = this.published.slice(this.deliveredCount);
    this.deliveredCount = this.published.length;
    return batch;
  }

  /** Redeliver everything, as Pub/Sub may after an acknowledgment is lost. */
  redeliverAll(): BusMessage[] {
    return this.published.map((m) => ({ ...m, deliveryAttempt: m.deliveryAttempt + 1 }));
  }

  /** Publish-side duplicate: same logical event, different message id. */
  duplicatePublishSide(): BusMessage[] {
    return this.published.map((m, i) => ({
      ...m,
      messageId: `${m.messageId}-pubdup-${i}`,
      deliveryAttempt: 1,
    }));
  }

  get publishedCount(): number {
    return this.published.length;
  }
}

/**
 * Relays committed outbox rows to the bus.
 *
 * Publish first, mark second. If the process dies in between, the row is
 * published again on the next pass. That is the honest failure mode of an
 * outbox, and it is why the consumer must deduplicate.
 */
export class OutboxRelay {
  private store: TransactionalStore;
  private bus: MessageBus;
  private clock: Clock;
  private sequence = 0;

  constructor(store: TransactionalStore, bus: MessageBus, clock: Clock) {
    this.store = store;
    this.bus = bus;
    this.clock = clock;
  }

  async publishPending(): Promise<number> {
    const pending = await this.store.runTransaction<OutboxRecord[]>((tx) =>
      tx.scan<OutboxRecord>(TABLES.OUTBOX, (r) => r.publishedAtMs === null),
    );
    for (const row of pending) {
      this.bus.publish({
        messageId: `msg_${String(++this.sequence).padStart(6, "0")}`,
        effectId: row.effectId,
        eventType: row.eventType,
        payload: row.payload,
      });
      await this.store.runTransaction((tx) => {
        const current = tx.read<OutboxRecord>(TABLES.OUTBOX, row.outboxId);
        if (current) {
          tx.write(TABLES.OUTBOX, row.outboxId, {
            ...current,
            publishedAtMs: this.clock.nowMs(),
          });
        }
      });
    }
    return pending.length;
  }
}

/**
 * Downstream accounting consumer with a transactional inbox.
 *
 * The inbox row and the ledger posting are written in one transaction, keyed
 * on effect identity rather than message id, so neither a redelivery nor a
 * publish-side duplicate with a fresh message id can post twice.
 */
export class LedgerConsumer {
  private store: TransactionalStore;
  private clock: Clock;
  handledCount = 0;
  skippedDuplicateCount = 0;

  constructor(store: TransactionalStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  async handle(message: BusMessage): Promise<"POSTED" | "DUPLICATE" | "IGNORED"> {
    this.handledCount++;
    if (message.eventType !== "payment.succeeded") return "IGNORED";

    return this.store.runTransaction<"POSTED" | "DUPLICATE">((tx) => {
      const seen = tx.read<{ effectId: string }>(TABLES.INBOX, message.effectId);
      if (seen) {
        this.skippedDuplicateCount++;
        return "DUPLICATE";
      }
      tx.write(TABLES.INBOX, message.effectId, {
        effectId: message.effectId,
        firstSeenAtMs: this.clock.nowMs(),
        eventType: message.eventType,
      });
      const entry: LedgerEntry = {
        effectId: message.effectId,
        operationId: String(message.payload.operationId),
        businessReference: String(message.payload.businessReference),
        amountMinor: Number(message.payload.amountMinor),
        currency: String(message.payload.currency),
        direction: "DEBIT",
        postedAtMs: this.clock.nowMs(),
      };
      tx.write(TABLES.LEDGER, entry.effectId, entry);
      return "POSTED";
    });
  }

  async handleAll(messages: BusMessage[]): Promise<void> {
    for (const m of messages) await this.handle(m);
  }
}
