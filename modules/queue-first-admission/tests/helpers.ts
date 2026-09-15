import type { QueueView } from "../src/admission.ts";
import type { TenantId } from "../src/types.ts";

export function view(over: Partial<QueueView> = {}): QueueView {
  return {
    depth: 0,
    oldestAgeMs: 0,
    perTenantDepth: new Map<TenantId, number>(),
    drainRatePerSec: 200,
    freeSlots: 20,
    outstandingReservations: 0,
    ...over,
  };
}
