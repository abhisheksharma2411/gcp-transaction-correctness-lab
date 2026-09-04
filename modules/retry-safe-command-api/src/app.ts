import {
  BUSINESS_REFERENCE_INDEX,
  InMemoryTransactionalStore,
  type TransactionalStore,
} from "./store.ts";
import { DeterministicProvider, type Fault } from "./provider.ts";
import { PaymentService, type ServiceConfig } from "./payment-service.ts";
import { LedgerConsumer, MessageBus, OutboxRelay } from "./outbox.ts";
import { deterministicClock, type Clock } from "./clock.ts";
import { auditEffects, type EffectAudit } from "./invariants.ts";

export interface Lab {
  store: TransactionalStore;
  provider: DeterministicProvider;
  service: PaymentService;
  bus: MessageBus;
  relay: OutboxRelay;
  consumer: LedgerConsumer;
  clock: Clock;
  /** Publish committed events and let the consumer post them. */
  deliver(): Promise<void>;
  audit(options?: { allowOpenOperations?: boolean; allowManualReview?: boolean }): EffectAudit;
  /**
   * Simulates a process restart: everything in memory is rebuilt, the durable
   * store and the provider survive. Anything the service kept only in a field
   * is lost, which is the point of the test.
   */
  restart(): Lab;
}

export interface LabOptions {
  faults?: Fault[];
  config?: Partial<ServiceConfig>;
  clock?: Clock;
  store?: TransactionalStore;
  provider?: DeterministicProvider;
}

export function createLab(options: LabOptions = {}): Lab {
  const clock = options.clock ?? deterministicClock();
  const store =
    options.store ?? new InMemoryTransactionalStore([BUSINESS_REFERENCE_INDEX]);
  const provider = options.provider ?? new DeterministicProvider(options.faults ?? []);
  const service = new PaymentService(store, provider, clock, options.config);
  const bus = new MessageBus();
  const relay = new OutboxRelay(store, bus, clock);
  const consumer = new LedgerConsumer(store, clock);

  const lab: Lab = {
    store,
    provider,
    service,
    bus,
    relay,
    consumer,
    clock,
    async deliver() {
      await relay.publishPending();
      await consumer.handleAll(bus.drain());
    },
    audit(auditOptions = {}) {
      return auditEffects(store, provider, auditOptions);
    },
    restart() {
      return createLab({ ...options, store, provider, clock });
    },
  };
  return lab;
}
