// The outbox relay: the process that moves committed rows into the broker.
//
// The relay is where the outbox pattern's honest failure mode lives. Publishing
// and recording that you published are two writes to two systems, which is the
// same dual-write problem one layer out -- and this time it is unavoidable,
// because the second system is the broker. The difference is that the surviving
// failure is a *duplicate*, which a consumer can absorb, rather than a *loss*,
// which it cannot.

import { orderingKeyFor } from "./identity.ts";
import { SimulatedCrash } from "./source.ts";
import type { Broker } from "./broker.ts";
import type { OrderService } from "./source.ts";
import type { Trace } from "./trace.ts";
import type { CrashPoint, OutboxRow } from "./types.ts";

export interface RelayOptions {
  readonly name: string;
  readonly batchSize: number;
  /** How long a claim holds a row against other relay instances. */
  readonly leaseMs: number;
  readonly topic: string;
}

export interface RelayRun {
  readonly claimed: number;
  readonly published: number;
  readonly checkpointed: number;
}

export class OutboxRelay {
  readonly name: string;
  private readonly source: OrderService;
  private readonly broker: Broker;
  private readonly trace: Trace;
  private readonly options: RelayOptions;

  constructor(source: OrderService, broker: Broker, trace: Trace, options: RelayOptions) {
    this.source = source;
    this.broker = broker;
    this.trace = trace;
    this.options = options;
    this.name = options.name;
  }

  /**
   * One pass: claim a batch, publish it, record that it was published.
   *
   * `crashAt: "after-publish-before-checkpoint"` stops between the second and
   * third step, which is the window that makes the relay an at-least-once
   * publisher rather than a once publisher.
   */
  runOnce(nowMs: number, crashAt: CrashPoint = "none"): RelayRun {
    const batch = this.claim(nowMs);
    let published = 0;
    let checkpointed = 0;

    for (const row of batch) {
      // Publishing in sequence order within an aggregate is the relay's half of
      // the ordering contract. The broker's ordering key is the other half, and
      // neither alone is enough.
      void orderingKeyFor(row.envelope);
      this.broker.publish(this.options.topic, row.envelope, nowMs, this.name);
      row.publishAttempts += 1;
      published += 1;

      if (crashAt === "after-publish-before-checkpoint") {
        this.trace.record({
          kind: "crash",
          atMs: nowMs,
          component: `relay:${this.name}`,
          at: "after-publish-before-checkpoint",
        });
        throw new SimulatedCrash(`relay:${this.name}`, "after-publish-before-checkpoint");
      }

      row.publishedAtMs = nowMs;
      row.leaseOwner = null;
      row.leaseExpiresAtMs = null;
      checkpointed += 1;
      this.trace.record({
        kind: "checkpoint",
        atMs: nowMs,
        eventId: row.envelope.eventId,
        relay: this.name,
      });
    }

    return { claimed: batch.length, published, checkpointed };
  }

  /** Drain the outbox, with a bound so a bug cannot spin forever. */
  drain(nowMs: number, maxPasses = 50): RelayRun {
    let claimed = 0;
    let published = 0;
    let checkpointed = 0;
    for (let i = 0; i < maxPasses; i += 1) {
      const run = this.runOnce(nowMs + i, "none");
      claimed += run.claimed;
      published += run.published;
      checkpointed += run.checkpointed;
      if (run.claimed === 0) break;
    }
    return { claimed, published, checkpointed };
  }

  /**
   * Claim rows under a lease.
   *
   * The lease is not a lock and does not pretend to be one. It is a bound on
   * how long a dead relay can keep a row to itself. Two relays whose clocks
   * disagree can both claim the same row, which is why the lease protects
   * throughput rather than correctness -- correctness is the consumer's inbox.
   */
  private claim(nowMs: number): OutboxRow[] {
    const batch = this.source.claimable(nowMs).slice(0, this.options.batchSize);
    for (const row of batch) {
      row.leaseOwner = this.name;
      row.leaseExpiresAtMs = nowMs + this.options.leaseMs;
    }
    return batch;
  }
}
