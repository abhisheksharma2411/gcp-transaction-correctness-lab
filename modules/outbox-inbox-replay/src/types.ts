// The vocabulary of the module.
//
// This is a local, deterministic model. It is not a Google Cloud client, opens
// no connection, holds no credential and needs no project. Every platform
// behaviour it represents is cited in ../docs/MODEL.md against public
// documentation; where the model simplifies, MODEL.md says so.

/** How an event's schema is versioned. A consumer either knows a version or it does not. */
export type SchemaVersion = 1 | 2 | 3;

/**
 * Everything that identifies one event.
 *
 * `operationId` is the identity of the *business operation* that caused this
 * event. Article 12 owns how that identity is chosen and how it survives a hop;
 * this module carries it and does not re-derive it. Every other field here is
 * the event's own identity, which is a different thing: one operation can emit
 * several events, and each needs to be recognisable on its own.
 */
export interface EventEnvelope {
  /** Derived from (aggregateType, aggregateId, sequence, eventType). Stable across republication. */
  readonly eventId: string;
  readonly aggregateType: string;
  /** The entity whose history this event belongs to. Also the ordering key. */
  readonly aggregateId: string;
  /** Position in that aggregate's history. Gap-free and increasing, by construction. */
  readonly sequence: number;
  readonly eventType: string;
  readonly schemaVersion: SchemaVersion;
  /** When the source transaction committed. Not when the message was published. */
  readonly recordedAtMs: number;
  /** The business operation that caused this event. See Article 12. */
  readonly operationId: string;
  /** The event or command that caused this one, for lineage. Null for the first in a chain. */
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A row in the outbox table, written in the same transaction as the business change. */
export interface OutboxRow {
  readonly envelope: EventEnvelope;
  /** The transaction that wrote both this row and the business change. */
  readonly txId: string;
  readonly committedAtMs: number;
  /** Null until a relay has published it and recorded that it did. */
  publishedAtMs: number | null;
  /** Which relay instance holds the claim, and until when. */
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  /** How many times a relay has attempted to publish this row. */
  publishAttempts: number;
}

/** A message as the broker holds it. */
export interface BrokerMessage {
  /** Unique per publish call. Two publishes of one event carry different ids. */
  readonly messageId: string;
  readonly topic: string;
  readonly orderingKey: string;
  readonly publishTimeMs: number;
  readonly body: EventEnvelope;
  /** Counted per subscription; reset to 0 by a seek. */
  deliveryAttempt: number;
  /** Set when the broker forwards this message to a dead-letter topic. */
  deadLetteredFrom: string | null;
}

/** What a consumer records to show it has seen an event. Written with the effect, atomically. */
export interface InboxRow {
  readonly consumer: string;
  readonly eventId: string;
  readonly processedAtMs: number;
  readonly effectIds: readonly string[];
}

/** An externally visible action that must not happen twice. */
export interface EffectRecord {
  /** Derived from (consumer, eventId, kind, subject). Two consumers never collide. */
  readonly effectId: string;
  readonly consumer: string;
  readonly kind: string;
  readonly subject: string;
  readonly eventId: string;
  readonly appliedAtMs: number;
}

/** Every step worth auditing, in the order it happened. The verifier reads only this. */
export type TraceEvent =
  | { kind: "tx-begin"; atMs: number; txId: string; aggregateId: string }
  | { kind: "tx-abort"; atMs: number; txId: string; reason: string }
  | { kind: "commit"; atMs: number; txId: string; aggregateId: string; sequence: number }
  | { kind: "outbox-write"; atMs: number; txId: string; eventId: string }
  | { kind: "publish"; atMs: number; eventId: string; messageId: string; relay: string; attempt: number }
  | { kind: "checkpoint"; atMs: number; eventId: string; relay: string }
  | { kind: "deliver"; atMs: number; messageId: string; eventId: string; consumer: string; deliveryAttempt: number }
  | { kind: "inbox-hit"; atMs: number; consumer: string; eventId: string }
  | { kind: "effect"; atMs: number; consumer: string; effectId: string; eventId: string; effectKind: string }
  | { kind: "effect-suppressed"; atMs: number; consumer: string; effectId: string; eventId: string }
  | { kind: "ack"; atMs: number; consumer: string; messageId: string }
  | { kind: "nack"; atMs: number; consumer: string; messageId: string; reason: string }
  | { kind: "ack-lost"; atMs: number; consumer: string; messageId: string }
  | { kind: "deferred"; atMs: number; consumer: string; eventId: string; expected: number; got: number }
  | { kind: "stale"; atMs: number; consumer: string; eventId: string; highWater: number }
  | { kind: "unhandled-version"; atMs: number; consumer: string; eventId: string; schemaVersion: number; routedToDeadLetter: boolean }
  | { kind: "dead-letter"; atMs: number; messageId: string; eventId: string; subscription: string; reason: string }
  | { kind: "dead-letter-repair"; atMs: number; eventId: string; action: string }
  | { kind: "replay-plan"; atMs: number; batchId: string; eventIds: readonly string[]; dryRun: boolean }
  | { kind: "replay-publish"; atMs: number; batchId: string; eventId: string }
  | { kind: "crash"; atMs: number; component: string; at: string };

/** One thing the lineage verifier found wrong. */
export interface Finding {
  readonly code: FindingCode;
  readonly severity: "high" | "medium";
  readonly detail: string;
  readonly refs: readonly string[];
}

export type FindingCode =
  | "L01_MISSING_EVENT"
  | "L02_PHANTOM_EVENT"
  | "L03_UNPUBLISHED"
  | "L04_UNDELIVERED"
  | "L05_DUPLICATE_PROTECTED_EFFECT"
  | "L06_UNHANDLED_SCHEMA_VERSION"
  | "L07_ORPHAN_EFFECT"
  | "L08_ORDER_VIOLATION"
  | "L09_REPLAY_DIVERGENCE"
  | "L10_DEAD_LETTER_UNRESOLVED";

export const FINDING_CODES: readonly FindingCode[] = [
  "L01_MISSING_EVENT",
  "L02_PHANTOM_EVENT",
  "L03_UNPUBLISHED",
  "L04_UNDELIVERED",
  "L05_DUPLICATE_PROTECTED_EFFECT",
  "L06_UNHANDLED_SCHEMA_VERSION",
  "L07_ORPHAN_EFFECT",
  "L08_ORDER_VIOLATION",
  "L09_REPLAY_DIVERGENCE",
  "L10_DEAD_LETTER_UNRESOLVED",
];

/** Where a run is told to stop dead. Every one of these is a real failure window. */
export type CrashPoint =
  | "none"
  | "before-commit"
  | "after-commit-before-publish"
  | "after-publish-before-checkpoint"
  | "after-effect-before-ack";

/** The four numbers a dual-write design has to keep apart. */
export interface RunTally {
  committedChanges: number;
  eventsPublished: number;
  deliveries: number;
  protectedEffects: number;
}
