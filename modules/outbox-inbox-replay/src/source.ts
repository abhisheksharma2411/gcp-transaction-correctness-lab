// The source service: the thing that changes durable business state and owes
// the rest of the system an event about it.
//
// Three capture strategies are implemented side by side, because the article's
// argument is a comparison and a comparison needs the alternatives to actually
// run:
//
//   "outbox"               business row and event row in one transaction
//   "publish-after-commit" commit, then publish; the honest naive version
//   "publish-before-commit" publish, then commit; the other naive version
//
// The two naive strategies are not strawmen. Each is correct whenever the
// process does not die in its window, which is almost always, which is exactly
// why they survive code review.

import { makeEnvelope } from "./identity.ts";
import type { Trace } from "./trace.ts";
import type { Broker } from "./broker.ts";
import type { CrashPoint, EventEnvelope, OutboxRow, SchemaVersion } from "./types.ts";

export type CaptureStrategy = "outbox" | "publish-after-commit" | "publish-before-commit";

export interface Order {
  readonly orderId: string;
  status: string;
  /** Gap-free, increasing. The event's sequence comes from here. */
  version: number;
  readonly lines: readonly { sku: string; quantity: number }[];
}

/** Raised by an injected crash. Callers catch it; nothing recovers inside a component. */
export class SimulatedCrash extends Error {
  readonly component: string;
  readonly at: string;
  constructor(component: string, at: string) {
    super(`simulated crash in ${component} at ${at}`);
    this.name = "SimulatedCrash";
    this.component = component;
    this.at = at;
  }
}

export interface ConfirmInput {
  readonly orderId: string;
  readonly operationId: string;
  readonly lines: readonly { sku: string; quantity: number }[];
  readonly schemaVersion: SchemaVersion;
  readonly nowMs: number;
  readonly crashAt?: CrashPoint;
  readonly causationId?: string | null;
}

export class OrderService {
  readonly orders = new Map<string, Order>();
  readonly outbox = new Map<string, OutboxRow>();
  readonly strategy: CaptureStrategy;
  private readonly trace: Trace;
  private readonly broker: Broker | null;
  private readonly topic: string;
  private txCounter = 0;

  constructor(opts: {
    strategy: CaptureStrategy;
    trace: Trace;
    broker?: Broker | null;
    topic?: string;
  }) {
    this.strategy = opts.strategy;
    this.trace = opts.trace;
    this.broker = opts.broker ?? null;
    this.topic = opts.topic ?? "orders";
  }

  /**
   * Confirm an order and emit the event that says so.
   *
   * The whole article lives in the ordering of the four lines below the switch.
   */
  confirm(input: ConfirmInput): EventEnvelope {
    const crashAt = input.crashAt ?? "none";
    const txId = `tx-${String(++this.txCounter).padStart(3, "0")}`;
    const existing = this.orders.get(input.orderId);
    const nextVersion = (existing?.version ?? 0) + 1;

    this.trace.record({ kind: "tx-begin", atMs: input.nowMs, txId, aggregateId: input.orderId });

    const envelope = makeEnvelope({
      aggregateType: "order",
      aggregateId: input.orderId,
      sequence: nextVersion,
      eventType: "OrderConfirmed",
      schemaVersion: input.schemaVersion,
      recordedAtMs: input.nowMs,
      operationId: input.operationId,
      causationId: input.causationId ?? null,
      payload: { lines: input.lines.map((l) => ({ ...l })) },
    });

    if (this.strategy === "publish-before-commit") {
      // Publish first so that nothing is lost. Nothing is lost. Instead, a
      // crash before the commit leaves a published event describing a state
      // change that never happened -- a phantom, and the one failure mode a
      // downstream consumer cannot repair, because there is nothing to repair
      // to.
      this.requireBroker().publish(this.topic, envelope, input.nowMs, "inline");
    }

    if (crashAt === "before-commit") {
      this.trace.record({ kind: "tx-abort", atMs: input.nowMs, txId, reason: "crash before commit" });
      this.trace.record({ kind: "crash", atMs: input.nowMs, component: "source", at: "before-commit" });
      throw new SimulatedCrash("source", "before-commit");
    }

    // --- the commit -------------------------------------------------------
    const order: Order = existing ?? { orderId: input.orderId, status: "NEW", version: 0, lines: input.lines };
    order.status = "CONFIRMED";
    order.version = nextVersion;
    this.orders.set(input.orderId, order);

    if (this.strategy === "outbox") {
      // Same transaction. Not "immediately after" and not "in a finally block".
      this.outbox.set(envelope.eventId, {
        envelope,
        txId,
        committedAtMs: input.nowMs,
        publishedAtMs: null,
        leaseOwner: null,
        leaseExpiresAtMs: null,
        publishAttempts: 0,
      });
      this.trace.record({ kind: "outbox-write", atMs: input.nowMs, txId, eventId: envelope.eventId });
    }

    this.trace.record({
      kind: "commit",
      atMs: input.nowMs,
      txId,
      aggregateId: input.orderId,
      sequence: nextVersion,
    });
    // --- end of the commit ------------------------------------------------

    if (crashAt === "after-commit-before-publish") {
      this.trace.record({
        kind: "crash",
        atMs: input.nowMs,
        component: "source",
        at: "after-commit-before-publish",
      });
      throw new SimulatedCrash("source", "after-commit-before-publish");
    }

    if (this.strategy === "publish-after-commit") {
      // The window is between the commit above and this line. It is small. It
      // is not zero, and a process can die in it for reasons that have nothing
      // to do with this code -- a node preemption, an OOM kill, a deploy.
      this.requireBroker().publish(this.topic, envelope, input.nowMs, "inline");
    }

    return envelope;
  }

  /** Rows a relay may claim: committed, not yet published, not leased by someone else. */
  claimable(nowMs: number): OutboxRow[] {
    return [...this.outbox.values()]
      .filter((r) => r.publishedAtMs === null)
      .filter((r) => r.leaseOwner === null || (r.leaseExpiresAtMs ?? 0) <= nowMs)
      .sort((a, b) =>
        a.committedAtMs - b.committedAtMs || a.envelope.sequence - b.envelope.sequence,
      );
  }

  /** Every committed event, for replay and for projection rebuild. */
  eventLog(): EventEnvelope[] {
    return [...this.outbox.values()]
      .map((r) => r.envelope)
      .sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.sequence - b.sequence);
  }

  private requireBroker(): Broker {
    if (this.broker === null) {
      throw new Error(`strategy ${this.strategy} needs a broker`);
    }
    return this.broker;
  }
}
