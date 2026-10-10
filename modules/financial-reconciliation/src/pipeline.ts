// The pipeline: immutable raw evidence in, accepted financial effects out.
//
// Five gates stand between a delivery and a posting, and they catch different
// things:
//
//   1. the raw store     one delivery id, stored once, never overwritten
//   2. the lateness gate evidence older than the watermark allows is dropped
//   3. statement dedup   one assertion, however many deliveries carried it
//   4. the engine        one business decision per transaction and purpose
//   5. the ledger        one entry per transaction and purpose
//
// Only gates 3, 4 and 5 affect the money. Gate 1 affects cost and knowledge,
// which is a weaker claim than it looks like it should be and is stated
// plainly here rather than implied by the diagram. Gate 2 affects neither: it
// loses evidence, and the only reason that is survivable is gate 1.

import { Ledger } from "./ledger.ts";
import { Correlator, naiveEvidenceId, stateDigest } from "./identity.ts";
import { RawEvidenceStore } from "./evidence.ts";
import { Reconciler } from "./reconcile.ts";
import type { ReconcileConfig } from "./reconcile.ts";
import { normalize } from "./normalize.ts";
import { emptyTally } from "./types.ts";
import type {
  ExceptionItem, JournalEntry, Observation, RawRecord, Resolution, Tally,
} from "./types.ts";

/**
 * Mechanisms this pipeline can be built without.
 *
 * Every flag here exists so that a case in src/cases.ts can be shown to turn
 * red when the mechanism is removed. A gate that nothing notices the absence
 * of is not protecting anything, and finding one of those is a result.
 */
export interface Weaknesses {
  /** Process a delivery even when the raw store says it was already stored. */
  readonly noDeliveryDedup?: boolean;
  /** Let a second delivery of the same id overwrite the stored body. */
  readonly noRawImmutability?: boolean;
  /** Post every assertion, however many assertions say the same thing. */
  readonly noStatementDedup?: boolean;
  /** Identify evidence by hashing the delivery body as it arrived. */
  readonly naiveIdentity?: boolean;
  /** Treat each source's reference as its own transaction. */
  readonly noCorrelation?: boolean;
  /** Remove the ledger's entry-id guard, the only durable one. */
  readonly noEntryDedup?: boolean;
  /** Let a correction rewrite a position that was already published as final. */
  readonly noFinalityGate?: boolean;
  /** The blunt control: post everything twice. Expected to be rejected. */
  readonly postEverythingTwice?: boolean;
}

export const WEAKNESSES: readonly (keyof Weaknesses)[] = [
  "noDeliveryDedup", "noRawImmutability", "noStatementDedup", "naiveIdentity",
  "noCorrelation", "noEntryDedup", "noFinalityGate", "postEverythingTwice",
];

export interface PipelineConfig {
  /**
   * How far behind the watermark a record may be and still be processed.
   *
   * Beam's default windowing "does not allow late data" at all, and allowed
   * lateness is something you set. The number you set is compared against the
   * window in which the financial network can still correct itself, and if it
   * is smaller you are dropping corrections. That comparison is the experiment
   * this module exists to run.
   */
  readonly allowedLatenessMs: number;
  readonly reconcile: ReconcileConfig;
  readonly weaknesses?: Weaknesses;
}

/** Where each delivery stopped. Keys are stable so the report can be diffed. */
export type StoppedBy =
  | "raw-store"
  | "late-window"
  | "statement-dedup"
  | "engine"
  | "ledger-entry-dedup"
  | "accepted";

export interface DroppedRecord {
  readonly sourceEventId: string;
  readonly ref: string;
  readonly kind: string;
  readonly occurredAtMs: number;
  readonly watermarkMs: number;
  readonly behindByMs: number;
}

export interface IngestReport {
  readonly delivered: number;
  readonly stoppedBy: Readonly<Record<string, number>>;
  readonly entriesPosted: number;
  readonly exceptions: readonly ExceptionItem[];
  readonly dropped: readonly DroppedRecord[];
}

export class Pipeline {
  readonly raw = new RawEvidenceStore();
  readonly ledger = new Ledger();
  /** Derived, and therefore rebuildable. See `rebuildDerived`. */
  reconciler: Reconciler;
  correlator = new Correlator();
  readonly tally: Tally = emptyTally();
  readonly stoppedBy: Record<string, number> = {};
  readonly dropped: DroppedRecord[] = [];
  readonly malformed: ExceptionItem[] = [];

  private readonly config: PipelineConfig;
  private readonly weak: Weaknesses;
  private seenStatements = new Set<string>();
  /**
   * Delivery id to evidence id, so that a correction can reference the
   * original the way a source actually references it.
   *
   * Nacha reversals identify the erroneous entry by its own fields; a provider
   * webhook references the original event id. Neither knows the content hash
   * this system computed, so the resolution has to happen here.
   */
  private evidenceBySourceEvent = new Map<string, string>();
  /** Event-time high-water mark across everything processed so far. */
  private watermarkMs = Number.NEGATIVE_INFINITY;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.weak = config.weaknesses ?? {};
    this.reconciler = new Reconciler({
      ...config.reconcile,
      finalityGate: this.weak.noFinalityGate ? false : config.reconcile.finalityGate,
    });
  }

  private note(where: StoppedBy): void {
    this.stoppedBy[where] = (this.stoppedBy[where] ?? 0) + 1;
  }

  ingest(records: readonly RawRecord[]): IngestReport {
    const before = this.ledger.count;
    const exceptions: ExceptionItem[] = [];
    const droppedHere: DroppedRecord[] = [];
    let delivered = 0;

    for (const record of records) {
      delivered += 1;
      this.tally.deliveries += 1;

      const outcome = this.raw.put(record);
      if (outcome === "PRECONDITION_CONFLICT" && !this.weak.noRawImmutability) {
        // The same delivery id arrived carrying a different body. The stored
        // object is unchanged; what is new is the knowledge that an upstream
        // system is reusing an identity, and that is worth a human.
        const c = this.reconciler.caseFor(`unknown:${record.sourceEventId}`, "XXX");
        const item: ExceptionItem = {
          reason: "RAW_IMMUTABLE_CONFLICT",
          transactionId: c.transactionId,
          evidenceId: null,
          detail: `${RawEvidenceStore.name(record.source, record.sourceEventId)} already stored with a different body`,
          raisedAtMs: record.receivedAtMs,
        };
        c.exceptions.push(item);
        c.state = "EXCEPTION";
        exceptions.push(item);
        this.tally.duplicateDeliveries += 1;
        this.note("raw-store");
        continue;
      }
      if (outcome === "DUPLICATE_DELIVERY") {
        this.tally.duplicateDeliveries += 1;
        if (!this.weak.noDeliveryDedup) {
          this.note("raw-store");
          continue;
        }
      }

      const result = this.process(record, exceptions, droppedHere);
      this.note(result);
    }

    return {
      delivered,
      stoppedBy: { ...this.stoppedBy },
      entriesPosted: this.ledger.count - before,
      exceptions,
      dropped: droppedHere,
    };
  }

  private process(
    record: RawRecord, exceptions: ExceptionItem[], droppedHere: DroppedRecord[],
  ): StoppedBy {
    this.tally.computations += 1;

    const normalized = normalize(record);
    if (!normalized.ok) {
      const c = this.reconciler.caseFor(`malformed:${record.sourceEventId}`, "XXX");
      const item: ExceptionItem = {
        reason: "MALFORMED_RECORD",
        transactionId: c.transactionId,
        evidenceId: null,
        detail: normalized.detail,
        raisedAtMs: record.receivedAtMs,
      };
      c.exceptions.push(item);
      c.state = "EXCEPTION";
      this.malformed.push(item);
      exceptions.push(item);
      return "engine";
    }

    let obs: Observation = normalized.observation;
    if (this.weak.naiveIdentity) {
      obs = { ...obs, evidenceId: naiveEvidenceId(record.body) };
    }

    // --- gate 2: the lateness window ---------------------------------------
    //
    // Compared against the watermark as it stood *before* this record, which
    // is the behaviour a windowed pipeline has: a record cannot make itself
    // timely by advancing the watermark it is being judged against.
    if (
      this.watermarkMs !== Number.NEGATIVE_INFINITY &&
      obs.occurredAtMs < this.watermarkMs - this.config.allowedLatenessMs
    ) {
      const d: DroppedRecord = {
        sourceEventId: obs.sourceEventId,
        ref: obs.ref,
        kind: obs.kind,
        occurredAtMs: obs.occurredAtMs,
        watermarkMs: this.watermarkMs,
        behindByMs: this.watermarkMs - obs.occurredAtMs,
      };
      this.dropped.push(d);
      droppedHere.push(d);
      this.tally.droppedLate += 1;
      return "late-window";
    }
    if (obs.occurredAtMs > this.watermarkMs) this.watermarkMs = obs.occurredAtMs;

    // --- gate 3: one assertion, however many deliveries carried it ---------
    if (!this.weak.noStatementDedup && this.seenStatements.has(obs.evidenceId)) {
      this.tally.duplicateStatements += 1;
      return "statement-dedup";
    }
    if (this.seenStatements.has(obs.evidenceId)) this.tally.duplicateStatements += 1;
    this.seenStatements.add(obs.evidenceId);
    this.tally.statements += 1;

    this.evidenceBySourceEvent.set(obs.sourceEventId, obs.evidenceId);

    // --- correlation -------------------------------------------------------
    const transactionId = this.resolveTransactionId(obs);

    // --- gates 4 and 5 -----------------------------------------------------
    // A correction names the original the way its source names it. Resolving
    // that to an evidence id here keeps the wire format honest: the hash of
    // the correction is the hash of what arrived, not of what this system
    // decided it meant.
    const forApply = obs.corrects === null
      ? obs
      : { ...obs, corrects: this.evidenceBySourceEvent.get(obs.corrects) ?? obs.corrects };
    const applied = this.reconciler.apply(forApply, transactionId, record.receivedAtMs);
    exceptions.push(...applied.exceptions);

    let posted = 0;
    for (const entry of applied.entries) {
      posted += this.postEntry(entry);
      if (this.weak.postEverythingTwice) posted += this.postEntry(entry, false);
    }
    if (posted === 0) {
      return applied.exceptions.length > 0 ? "engine" : "ledger-entry-dedup";
    }
    return "accepted";
  }

  private postEntry(entry: JournalEntry, dedupe = true): number {
    const outcome = this.ledger.post(entry, dedupe && !this.weak.noEntryDedup);
    if (outcome === "POSTED") {
      this.tally.entries += 1;
      return 1;
    }
    return 0;
  }

  private resolveTransactionId(obs: Observation): string {
    if (this.weak.noCorrelation) return `${obs.source}:${obs.ref}`;

    const before = this.correlator.transactionId(obs.source, obs.ref);
    this.correlator.add(obs.source, obs.ref);
    for (const other of obs.alsoKnownAs) {
      const otherBefore = this.correlator.transactionId(other.source, other.ref);
      this.correlator.link({ source: obs.source, ref: obs.ref }, other);
      const root = this.correlator.transactionId(obs.source, obs.ref);
      // Correlation can arrive after a case already exists under the other
      // reference. Folding keeps one case; it cannot unpost what was already
      // posted under the old id, and docs/MODEL.md says what that costs.
      if (otherBefore !== root) this.reconciler.merge(otherBefore, root);
      if (before !== root) this.reconciler.merge(before, root);
    }
    return this.correlator.transactionId(obs.source, obs.ref);
  }

  /**
   * Re-run every stored delivery.
   *
   * This is the operational case the invariant is about: an operator reruns a
   * day of evidence after a partial failure, against the ledger that is
   * already there. Computation repeats. Accepted financial effects must not.
   */
  replay(): IngestReport {
    const before = this.ledger.count;
    const exceptions: ExceptionItem[] = [];
    const droppedHere: DroppedRecord[] = [];
    let delivered = 0;
    for (const stored of this.raw.all()) {
      delivered += 1;
      this.tally.deliveries += 1;
      // A replay reads *from* the store. It does not write to it, so the
      // create-if-absent precondition that stops an ordinary redelivery is not
      // in the path at all. Everything below it has to hold on its own.
      this.note(this.process(stored.record, exceptions, droppedHere));
    }
    return {
      delivered,
      stoppedBy: { ...this.stoppedBy },
      entriesPosted: this.ledger.count - before,
      exceptions,
      dropped: droppedHere,
    };
  }

  /**
   * Throw away everything that was derived and keep what was accepted.
   *
   * This is the recovery action the article is really about. The raw evidence
   * and the ledger survive; the de-duplication record, the correlation
   * structure and the reconciliation cases are rebuilt from scratch by
   * replaying the raw store. Article 12 ends on the observation that every
   * de-duplication window is finite; this method is that sentence made
   * executable, and what is left standing afterwards is a single property --
   * that an entry id is derived from the transaction and the purpose, so
   * re-deriving the same entry produces the same id and the ledger refuses it.
   */
  rebuildDerived(): void {
    this.reconciler = new Reconciler({
      ...this.config.reconcile,
      finalityGate: this.weak.noFinalityGate ? false : this.config.reconcile.finalityGate,
    });
    this.correlator = new Correlator();
    this.seenStatements = new Set<string>();
    this.evidenceBySourceEvent = new Map<string, string>();
    this.watermarkMs = Number.NEGATIVE_INFINITY;
  }

  close(nowMs: number): readonly ExceptionItem[] {
    return this.reconciler.close(nowMs);
  }

  resolve(
    input: { transactionId: string; actor: string; action: Resolution["action"]; note: string },
    nowMs: number,
  ): Resolution {
    const { resolution, entries } = this.reconciler.resolve(input, nowMs);
    for (const entry of entries) this.postEntry(entry);
    return resolution;
  }

  /**
   * A digest of everything the business would act on.
   *
   * Deliberately excludes arrival times, delivery ids and anything else that a
   * replay is allowed to change. Two runs over the same evidence must agree on
   * this string or the pipeline is not replayable, whatever the entry count
   * says.
   */
  digest(): string {
    const parts: unknown[] = [];
    for (const e of this.ledger.all()) {
      parts.push({
        t: e.transactionId, p: e.purpose, c: e.currency,
        post: e.postings.map((x) => [x.account, x.amountMinor]),
      });
    }
    for (const c of this.reconciler.cases.values()) {
      parts.push({
        case: c.transactionId, state: c.state, finality: c.finality,
        captured: c.capturedMinor, net: c.settledNetMinor, fee: c.settledFeeMinor,
        reversed: c.reversedMinor,
        exceptions: c.exceptions.map((x) => x.reason).sort(),
      });
    }
    return stateDigest(parts);
  }
}
