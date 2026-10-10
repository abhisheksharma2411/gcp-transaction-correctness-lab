// A read model, rebuilt from the event log.
//
// The rebuild is a check on the event stream, not a feature. If replaying the
// log from the beginning does not reproduce what the live consumer built, then
// either the events do not carry enough to reconstruct the state or the
// consumer is applying something that is not in them. Both are worth knowing
// before a recovery rather than during one.

import type { EventEnvelope } from "./types.ts";

export interface Projection {
  /** orderId -> highest applied sequence. */
  readonly versions: ReadonlyMap<string, number>;
  /** orderId -> sorted list of reserved skus. */
  readonly reservations: ReadonlyMap<string, readonly string[]>;
}

export function rebuildProjection(events: readonly EventEnvelope[]): Projection {
  const versions = new Map<string, number>();
  const reservations = new Map<string, string[]>();

  const ordered = [...events].sort(
    (a, b) => a.aggregateId.localeCompare(b.aggregateId) || a.sequence - b.sequence,
  );

  for (const e of ordered) {
    if (e.eventType !== "OrderConfirmed") continue;
    const seen = versions.get(e.aggregateId) ?? 0;
    if (e.sequence <= seen) continue;
    versions.set(e.aggregateId, e.sequence);
    const lines = (e.payload["lines"] ?? []) as { sku: string; quantity: number }[];
    const skus = lines.filter((l) => l.quantity > 0).map((l) => l.sku);
    reservations.set(e.aggregateId, [...new Set(skus)].sort());
  }

  return { versions, reservations };
}

/** A stable string form, so two projections can be compared by equality. */
export function projectionFingerprint(p: Projection): string {
  const rows = [...p.versions.keys()].sort().map((orderId) => {
    const skus = (p.reservations.get(orderId) ?? []).join(",");
    return `${orderId}@${p.versions.get(orderId)}:[${skus}]`;
  });
  return rows.join(";");
}
