// Event identity, effect identity, and the hash underneath both.
//
// Zero dependencies on purpose: the derivation has to be reproducible by a
// reader in another language, and a 20-line hash is easier to port than a
// dependency. It is not a cryptographic hash and nothing here is a security
// control.

import type { EventEnvelope, SchemaVersion } from "./types.ts";

/** FNV-1a, 64-bit, rendered as 16 hex characters. Deterministic across runs and platforms. */
export function hash(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The event's identity, derived rather than generated.
 *
 * Deriving it matters. A relay that crashes after publishing and republishes on
 * restart sends a second *message*; if the event id were a fresh UUID per
 * publish, that second message would be a second event and nothing downstream
 * could tell. Derived from the aggregate's history, the same logical change
 * always produces the same event id, so a consumer's inbox recognises it.
 */
export function deriveEventId(
  aggregateType: string,
  aggregateId: string,
  sequence: number,
  eventType: string,
): string {
  return `evt-${hash(`${aggregateType}|${aggregateId}|${sequence}|${eventType}`)}`;
}

/**
 * The identity of one protected effect.
 *
 * Deliberately **not** derived from the event id. An effect identity keyed on
 * the event id is only as stable as the event id, and the event id is a thing a
 * publisher can regenerate. Keyed on the aggregate's position in its own
 * history, the identity survives a republication under a fresh event id, which
 * is the case where the inbox is no help.
 *
 * `consumer` is part of the key for the opposite reason. Two consumers reacting
 * to one event are doing two different things and neither should suppress the
 * other. That is the difference between de-duplicating a message and
 * de-duplicating an effect.
 */
export function deriveEffectId(
  consumer: string,
  envelope: Pick<EventEnvelope, "aggregateType" | "aggregateId" | "sequence">,
  effectKind: string,
  subject: string,
): string {
  const position = `${envelope.aggregateType}:${envelope.aggregateId}#${envelope.sequence}`;
  return `eff-${hash(`${consumer}|${position}|${effectKind}|${subject}`)}`;
}

export interface EnvelopeInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly schemaVersion: SchemaVersion;
  readonly recordedAtMs: number;
  readonly operationId: string;
  readonly causationId?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function makeEnvelope(input: EnvelopeInput): EventEnvelope {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new Error(`sequence must be a positive integer, got ${input.sequence}`);
  }
  return {
    eventId: deriveEventId(input.aggregateType, input.aggregateId, input.sequence, input.eventType),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: input.sequence,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    recordedAtMs: input.recordedAtMs,
    operationId: input.operationId,
    causationId: input.causationId ?? null,
    payload: input.payload,
  };
}

/**
 * The ordering key.
 *
 * One aggregate, one key. Pub/Sub orders within a key and explicitly does not
 * order across keys, so the choice of key is the choice of what "in order" even
 * means for this system. Choosing a coarser key than the aggregate buys
 * ordering nobody needs and costs throughput everybody pays for.
 */
export function orderingKeyFor(envelope: EventEnvelope): string {
  return `${envelope.aggregateType}:${envelope.aggregateId}`;
}
