// The reconciliation engine: cases, exceptions, finality, resolutions.
//
// The engine never edits a figure it has already published. A correction
// produces an additional entry and leaves the original in place, which is the
// shape Nacha's reversal rules impose on ACH: a correcting entry is a new
// entry that carries the same identifying fields as the one it corrects, and
// it must reach the receiving institution within five banking days of the
// erroneous entry's settlement date. The deadline matters as much as the
// mechanism, and it is the reason `correctionWindowMs` is a first-class input
// to this engine rather than a constant buried in a sweep job.

import {
  adjustmentEntry, captureEntry, reversalEntry, settlementEntry,
  unallocatedSettlementEntry, writeOffEntry,
} from "./ledger.ts";
import type {
  ExceptionItem, ExceptionReason, JournalEntry, Observation, ReconCase, Resolution,
} from "./types.ts";

/** Everything the engine needs that is not evidence. */
export interface ReconcileConfig {
  /**
   * How long after the last accepted event a position stays open to revision.
   *
   * There is no universal value. ACH reversals must reach the receiving
   * institution within five banking days of the erroneous entry's settlement
   * date; a card scheme, a wallet and an invoice each have their own number.
   * What matters is that the number exists and that the pipeline's lateness
   * window is not smaller than it.
   */
  readonly correctionWindowMs: number;
  /** The fee the contract leads you to expect, as a model, not a schedule. */
  readonly expectedFeeBps: number;
  readonly expectedFeeFixedMinor: number;
  readonly feeToleranceMinor: number;
  /** Turning this off is a negative control, not an option. */
  readonly finalityGate: boolean;
}

export const DEFAULT_CONFIG: ReconcileConfig = {
  correctionWindowMs: 5 * 86_400_000,
  expectedFeeBps: 250,
  expectedFeeFixedMinor: 25,
  feeToleranceMinor: 1,
  finalityGate: true,
};

export interface ApplyResult {
  readonly entries: readonly JournalEntry[];
  readonly exceptions: readonly ExceptionItem[];
}

function newCase(transactionId: string, currency: string): ReconCase {
  return {
    transactionId,
    state: "OPEN",
    finality: "PROVISIONAL",
    evidence: [],
    refs: [],
    currency,
    capturedMinor: null,
    settledNetMinor: null,
    settledFeeMinor: null,
    reversedMinor: null,
    lastEventAtMs: 0,
    exceptions: [],
    resolutions: [],
    mergedFrom: [],
  };
}

export class Reconciler {
  readonly cases = new Map<string, ReconCase>();
  private readonly acceptedEvidence = new Map<string, Observation>();
  private readonly config: ReconcileConfig;

  constructor(config: ReconcileConfig) {
    this.config = config;
  }

  caseFor(transactionId: string, currency: string): ReconCase {
    let c = this.cases.get(transactionId);
    if (c === undefined) {
      c = newCase(transactionId, currency);
      this.cases.set(transactionId, c);
    }
    return c;
  }

  private raise(
    c: ReconCase, reason: ExceptionReason, evidence: string | null,
    detail: string, atMs: number,
  ): ExceptionItem {
    const item: ExceptionItem = {
      reason, transactionId: c.transactionId, evidenceId: evidence, detail, raisedAtMs: atMs,
    };
    c.exceptions.push(item);
    c.state = "EXCEPTION";
    return item;
  }

  expectedFee(grossMinor: number): number {
    return Math.round((grossMinor * this.config.expectedFeeBps) / 10_000)
      + this.config.expectedFeeFixedMinor;
  }

  /**
   * Accept one normalised assertion into its case.
   *
   * Returns the entries to post and the exceptions raised. The engine does not
   * post: the pipeline does, so that the decision and the effect stay
   * separable and the effect can be counted independently.
   */
  apply(obs: Observation, transactionId: string, nowMs: number): ApplyResult {
    const c = this.caseFor(transactionId, obs.currency);
    const entries: JournalEntry[] = [];
    const exceptions: ExceptionItem[] = [];

    c.evidence.push(obs.evidenceId);
    if (!c.refs.some((r) => r.source === obs.source && r.ref === obs.ref)) {
      c.refs.push({ source: obs.source, ref: obs.ref });
    }
    this.acceptedEvidence.set(obs.evidenceId, obs);
    if (obs.occurredAtMs > c.lastEventAtMs) c.lastEventAtMs = obs.occurredAtMs;

    if (obs.currency !== c.currency) {
      exceptions.push(this.raise(
        c, "CONTRADICTORY_SOURCES", obs.evidenceId,
        `currency ${obs.currency} against case currency ${c.currency}`, nowMs,
      ));
      return { entries, exceptions };
    }

    if (obs.corrects !== null) {
      return this.applyCorrection(c, obs, nowMs);
    }

    if (obs.coversRefs.length > 1) {
      // A settlement that the processor grouped differently from the way the
      // business groups transactions. Cash and fee are real; the allocation is
      // not known, so it is not invented.
      entries.push(unallocatedSettlementEntry(
        `group:${obs.evidenceId}`, obs.evidenceId, obs.occurredAtMs,
        obs.currency, obs.netMinor, obs.feeMinor,
      ));
      exceptions.push(this.raise(
        c, "UNALLOCATED_GROUPING", obs.evidenceId,
        `settlement covers ${obs.coversRefs.length} references without an allocation`, nowMs,
      ));
      return { entries, exceptions };
    }

    switch (obs.kind) {
      case "AUTHORIZED":
        // An authorisation moves no money. It is kept as evidence because it
        // is often the only record that carries the correlating reference.
        break;

      case "CAPTURED": {
        if (c.capturedMinor !== null && c.capturedMinor !== obs.grossMinor) {
          exceptions.push(this.raise(
            c, "CONTRADICTORY_SOURCES", obs.evidenceId,
            `capture ${obs.grossMinor} against ${c.capturedMinor} already accepted`, nowMs,
          ));
          break;
        }
        if (c.capturedMinor === null) {
          c.capturedMinor = obs.grossMinor;
          entries.push(captureEntry(
            c.transactionId, obs.evidenceId, obs.occurredAtMs, obs.currency, obs.grossMinor,
          ));
        }
        break;
      }

      case "SETTLED": {
        if (c.capturedMinor !== null && obs.grossMinor !== c.capturedMinor) {
          exceptions.push(this.raise(
            c, "CONTRADICTORY_SOURCES", obs.evidenceId,
            `settlement gross ${obs.grossMinor} against capture ${c.capturedMinor}`, nowMs,
          ));
          break;
        }
        const expected = this.expectedFee(obs.grossMinor);
        if (Math.abs(obs.feeMinor - expected) > this.config.feeToleranceMinor) {
          exceptions.push(this.raise(
            c, "FEE_UNEXPLAINED", obs.evidenceId,
            `fee ${obs.feeMinor} against expected ${expected}`, nowMs,
          ));
        }
        if (c.settledNetMinor === null) {
          c.settledNetMinor = obs.netMinor;
          c.settledFeeMinor = obs.feeMinor;
          entries.push(settlementEntry(
            c.transactionId, obs.evidenceId, obs.occurredAtMs,
            obs.currency, obs.netMinor, obs.feeMinor,
          ));
        }
        break;
      }

      case "REVERSED": {
        if (c.reversedMinor === null) {
          c.reversedMinor = obs.grossMinor;
          entries.push(reversalEntry(
            c.transactionId, obs.evidenceId, obs.occurredAtMs, obs.currency, obs.grossMinor,
          ));
        }
        break;
      }
    }

    if (c.state === "OPEN" && c.exceptions.length === 0) {
      c.state = this.settledConsistently(c) ? "MATCHED" : "OPEN";
    }
    return { entries, exceptions };
  }

  private settledConsistently(c: ReconCase): boolean {
    if (c.reversedMinor !== null && c.capturedMinor !== null) {
      return c.reversedMinor === c.capturedMinor;
    }
    if (c.capturedMinor === null || c.settledNetMinor === null) return false;
    return c.settledNetMinor + (c.settledFeeMinor ?? 0) === c.capturedMinor;
  }

  /**
   * A correction that arrives against evidence already accepted.
   *
   * Two things are checked before anything is posted. First, whether the
   * correction identifies something real and matches its key fields -- Nacha
   * requires the SEC code, company identification and amount of a reversal to
   * be identical to the original entry, and the same discipline here means a
   * correction that does not match is refused rather than applied. Second,
   * whether the position it corrects has already gone final.
   */
  private applyCorrection(c: ReconCase, obs: Observation, nowMs: number): ApplyResult {
    const entries: JournalEntry[] = [];
    const exceptions: ExceptionItem[] = [];
    const target = this.acceptedEvidence.get(obs.corrects!);

    if (target === undefined) {
      exceptions.push(this.raise(
        c, "INVALID_CORRECTION", obs.evidenceId,
        `corrects ${obs.corrects} which is not accepted evidence`, nowMs,
      ));
      return { entries, exceptions };
    }
    if (target.kind !== obs.kind || target.currency !== obs.currency || target.ref !== obs.ref) {
      exceptions.push(this.raise(
        c, "INVALID_CORRECTION", obs.evidenceId,
        `correction key fields differ from ${obs.corrects}`, nowMs,
      ));
      return { entries, exceptions };
    }

    const previous = target.kind === "SETTLED" ? target.netMinor : target.grossMinor;
    const current = obs.kind === "SETTLED" ? obs.netMinor : obs.grossMinor;
    const delta = current - previous;
    const account = obs.kind === "SETTLED" ? "settled_cash" : "merchant_receivable";

    if (c.finality === "FINAL" && this.config.finalityGate) {
      // The position was published as final and the world has contradicted it.
      // The original entry stays. The delta is posted against suspense and a
      // person is told, because this is a business event, not a data event.
      if (delta !== 0) {
        entries.push(adjustmentEntry(
          c.transactionId, obs.evidenceId, obs.occurredAtMs, obs.currency, delta, account,
        ));
      }
      exceptions.push(this.raise(
        c, "CORRECTION_AFTER_FINALITY", obs.evidenceId,
        `delta ${delta} after the position went final`, nowMs,
      ));
      return { entries, exceptions };
    }

    if (delta !== 0) {
      entries.push(adjustmentEntry(
        c.transactionId, obs.evidenceId, obs.occurredAtMs, obs.currency, delta, account,
      ));
    }
    if (obs.kind === "SETTLED") {
      c.settledNetMinor = obs.netMinor;
      c.settledFeeMinor = obs.feeMinor;
    } else if (obs.kind === "CAPTURED") {
      c.capturedMinor = obs.grossMinor;
    }
    // A corrected figure reopens the case rather than quietly staying matched.
    if (c.state === "MATCHED") c.state = "OPEN";
    return { entries, exceptions };
  }

  /**
   * The finality sweep.
   *
   * Nothing becomes final because time passed alone. It becomes final because
   * the correction window elapsed *and* the evidence is coherent. A case with
   * a capture and no settlement does not go final at the deadline; it goes to
   * an exception queue, where somebody has to say what happened to the money.
   */
  close(nowMs: number): readonly ExceptionItem[] {
    const raised: ExceptionItem[] = [];
    for (const c of this.cases.values()) {
      if (c.state === "RESOLVED" || c.finality === "FINAL") continue;
      if (nowMs < c.lastEventAtMs + this.config.correctionWindowMs) continue;

      if (c.capturedMinor !== null && c.settledNetMinor === null && c.reversedMinor === null) {
        // Raised once, however many times the sweep runs. A sweep that
        // re-raises its own exception teaches an operator to ignore the queue.
        if (!c.exceptions.some((x) => x.reason === "MISSING_SETTLEMENT")) {
          raised.push(this.raise(
            c, "MISSING_SETTLEMENT", null,
            `captured ${c.capturedMinor} with no settlement after the correction window`, nowMs,
          ));
        }
        c.state = "UNMATCHED";
        continue;
      }
      if (c.exceptions.length > 0) {
        c.state = "EXCEPTION";
        continue;
      }
      if (this.settledConsistently(c)) {
        c.state = "MATCHED";
        c.finality = "FINAL";
        continue;
      }
      c.state = "UNMATCHED";
    }
    return raised;
  }

  /**
   * Record an operator decision.
   *
   * Versioned and appended. A resolution never replaces its predecessor,
   * because the predecessor is the answer to "what did we believe last
   * Tuesday, and on what evidence", and that question outlives the decision.
   */
  resolve(
    input: { transactionId: string; actor: string; action: Resolution["action"]; note: string },
    nowMs: number,
  ): { resolution: Resolution; entries: readonly JournalEntry[] } {
    const c = this.cases.get(input.transactionId);
    if (c === undefined) throw new Error(`no case ${input.transactionId}`);
    if (input.actor.trim() === "") throw new Error("a resolution needs an actor");
    if (input.note.trim() === "") throw new Error("a resolution needs a note");

    const resolution: Resolution = {
      version: c.resolutions.length + 1,
      transactionId: c.transactionId,
      actor: input.actor,
      action: input.action,
      note: input.note,
      decidedAtMs: nowMs,
      evidenceSeen: [...c.evidence],
    };
    c.resolutions.push(resolution);

    const entries: JournalEntry[] = [];
    if (input.action === "REOPEN") {
      c.state = "OPEN";
      c.finality = "PROVISIONAL";
    } else if (input.action === "AWAIT_EVIDENCE") {
      c.state = "EXCEPTION";
      c.finality = "PROVISIONAL";
    } else if (input.action === "WRITE_OFF") {
      const residual = (c.capturedMinor ?? 0) - (c.settledNetMinor ?? 0) - (c.settledFeeMinor ?? 0);
      if (residual !== 0) {
        entries.push(writeOffEntry(
          c.transactionId, `resolution:${resolution.version}`, nowMs,
          c.currency, residual, resolution.version,
        ));
      }
      c.state = "RESOLVED";
      c.finality = "FINAL";
    } else {
      c.state = "RESOLVED";
      c.finality = "FINAL";
    }
    return { resolution, entries };
  }

  /**
   * Fold one case into another after a late correlation.
   *
   * Entries already posted under `fromId` keep that id. Rewriting them would
   * mean editing an accepted financial effect, which is the one thing this
   * module will not do, so the case records where it came from instead and
   * docs/MODEL.md says plainly what that costs.
   */
  merge(fromId: string, intoId: string): boolean {
    const from = this.cases.get(fromId);
    const into = this.cases.get(intoId);
    if (from === undefined || into === undefined || fromId === intoId) return false;
    for (const e of from.evidence) if (!into.evidence.includes(e)) into.evidence.push(e);
    for (const r of from.refs) {
      if (!into.refs.some((x) => x.source === r.source && x.ref === r.ref)) into.refs.push(r);
    }
    if (into.capturedMinor === null) into.capturedMinor = from.capturedMinor;
    if (into.settledNetMinor === null) {
      into.settledNetMinor = from.settledNetMinor;
      into.settledFeeMinor = from.settledFeeMinor;
    }
    if (into.reversedMinor === null) into.reversedMinor = from.reversedMinor;
    if (from.lastEventAtMs > into.lastEventAtMs) into.lastEventAtMs = from.lastEventAtMs;
    into.exceptions.push(...from.exceptions);
    into.resolutions.push(...from.resolutions);
    into.mergedFrom.push(fromId, ...from.mergedFrom);
    if (into.exceptions.length > 0) into.state = "EXCEPTION";
    this.cases.delete(fromId);
    return true;
  }

  /** Every exception currently open, sorted for a stable report. */
  exceptionQueue(): readonly ExceptionItem[] {
    const out: ExceptionItem[] = [];
    for (const c of this.cases.values()) {
      if (c.state === "RESOLVED") continue;
      out.push(...c.exceptions);
    }
    return out.sort((a, b) =>
      a.transactionId < b.transactionId ? -1
        : a.transactionId > b.transactionId ? 1
          : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);
  }
}
