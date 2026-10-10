// A deterministic generator for an event stream that already contains
// duplicates, late arrivals, corrections, reversals and fee differences.
//
// No wall clock and no randomness that is not seeded, so the same spec always
// produces the same bytes. That is the only reason the measured tables in
// results/ can be called reproducible rather than illustrative.
//
// One modelling decision here is worth more than the rest of the file. A
// correction carries the *event time of the thing it corrects*, not its own
// arrival time. Nacha's reversal rules measure the deadline from the
// settlement date of the erroneous entry, so a reversal issued four days later
// still belongs to the erroneous entry's day. Window by the correction's own
// timestamp and the correction looks timely; window by the transaction's and
// it is four days late. The second is the one that matches how the money is
// reported, and it is the reason late data is the central problem in this
// article rather than an edge case.

import type { RawRecord, SourceId } from "./types.ts";

export interface StreamSpec {
  readonly transactions: number;
  readonly seed: number;
  /** Event-time span the captures are spread across. */
  readonly spanMs: number;
  /** Event-time gap from capture to settlement. */
  readonly settleDelayMs: number;
  /** How far a delivery can be reordered against event time. */
  readonly jitterMs: number;
  readonly duplicateEvery: number;
  readonly restateEvery: number;
  readonly correctionEvery: number;
  readonly reversalEvery: number;
  readonly feeAnomalyEvery: number;
  readonly missingSettlementEvery: number;
  /** How often a second source reports the same transaction with other money. */
  readonly contradictionEvery: number;
}

export const DEFAULT_STREAM: StreamSpec = {
  transactions: 400,
  seed: 20260105,
  spanMs: 5 * 86_400_000,
  settleDelayMs: 26 * 3_600_000,
  jitterMs: 90 * 60_000,
  duplicateEvery: 7,
  restateEvery: 11,
  correctionEvery: 13,
  reversalEvery: 23,
  feeAnomalyEvery: 29,
  missingSettlementEvery: 17,
  contradictionEvery: 31,
};

export interface GeneratedStream {
  readonly records: readonly RawRecord[];
  /** What the generator intended, for comparison against what was measured. */
  readonly planted: {
    readonly transactions: number;
    readonly duplicateDeliveries: number;
    readonly restatedDeliveries: number;
    readonly corrections: number;
    readonly reversals: number;
    readonly feeAnomalies: number;
    readonly missingSettlements: number;
    readonly contradictions: number;
  };
}

/** A small linear congruential generator. Deterministic, and documented as weak. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function expectedFeeMinor(grossMinor: number): number {
  return Math.round((grossMinor * 250) / 10_000) + 25;
}

export function generate(spec: StreamSpec, epochMs: number): GeneratedStream {
  const rand = lcg(spec.seed);
  const spacing = spec.spanMs / spec.transactions;
  const main: { order: number; record: RawRecord }[] = [];
  const trailing: RawRecord[] = [];

  let duplicateDeliveries = 0;
  let restatedDeliveries = 0;
  let corrections = 0;
  let reversals = 0;
  let feeAnomalies = 0;
  let missingSettlements = 0;
  let contradictions = 0;

  const push = (record: RawRecord, order: number): void => {
    main.push({ order, record });
  };

  const body = (
    kind: string, ref: string, gross: number, fee: number, at: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    kind, ref, currency: "EUR", occurredAtMs: at, grossMinor: gross,
    feeMinor: fee, ...extra,
  });

  for (let i = 0; i < spec.transactions; i += 1) {
    const ref = `txn-${String(i).padStart(5, "0")}`;
    const gross = 500 + Math.floor(rand() * 49_500);
    const captureAt = epochMs + Math.round(i * spacing);
    const settleAt = captureAt + spec.settleDelayMs;
    const source: SourceId = "gateway";
    const jitter = Math.round((rand() - 0.5) * 2 * spec.jitterMs);

    push({
      sourceEventId: `cap-${i}`, source, receivedAtMs: captureAt + jitter,
      body: body("CAPTURED", ref, gross, 0, captureAt),
    }, captureAt + jitter);

    if (i % spec.duplicateEvery === 0) {
      duplicateDeliveries += 1;
      push({
        sourceEventId: `cap-${i}`, source, receivedAtMs: captureAt + jitter + 5_000,
        body: body("CAPTURED", ref, gross, 0, captureAt),
      }, captureAt + jitter + 5_000);
    }

    if (i % spec.contradictionEvery === 0) {
      contradictions += 1;
      // A second source, with its own reference, carrying the correlation and
      // a different amount. Correlation makes this one case; the amount makes
      // it an exception rather than a quiet overwrite.
      const at = captureAt + 120_000;
      push({
        sourceEventId: `pcap-${i}`, source: "processor", receivedAtMs: at + jitter,
        body: body("CAPTURED", `pi-${i}`, gross + 13, 0, at, {
          alsoKnownAs: [{ source: "gateway", ref }],
        }),
      }, at + jitter);
    }

    const reversed = i % spec.reversalEvery === 0;
    const missing = !reversed && i % spec.missingSettlementEvery === 0;

    if (reversed) {
      reversals += 1;
      const at = captureAt + 3_600_000;
      push({
        sourceEventId: `rev-${i}`, source, receivedAtMs: at + jitter,
        body: body("REVERSED", ref, gross, 0, at),
      }, at + jitter);
      continue;
    }
    if (missing) {
      missingSettlements += 1;
      continue;
    }

    const anomalous = i % spec.feeAnomalyEvery === 0;
    if (anomalous) feeAnomalies += 1;
    const fee = anomalous ? expectedFeeMinor(gross) + 300 : expectedFeeMinor(gross);
    const settleJitter = Math.round((rand() - 0.5) * 2 * spec.jitterMs);

    push({
      sourceEventId: `set-${i}`, source, receivedAtMs: settleAt + settleJitter,
      body: body("SETTLED", ref, gross, fee, settleAt),
    }, settleAt + settleJitter);

    if (i % spec.restateEvery === 0) {
      restatedDeliveries += 1;
      // A publish-side duplicate: the same assertion, a different delivery id.
      push({
        sourceEventId: `set-${i}-republished`, source,
        receivedAtMs: settleAt + settleJitter + 11_000,
        body: body("SETTLED", ref, gross, fee, settleAt),
      }, settleAt + settleJitter + 11_000);
    }

    if (i % spec.correctionEvery === 0) {
      corrections += 1;
      // Delivered after everything else, carrying the event time of the record
      // it corrects. This is the arrival that a short lateness window drops.
      trailing.push({
        sourceEventId: `cor-${i}`, source,
        receivedAtMs: epochMs + spec.spanMs + spec.settleDelayMs + 3_600_000 + i,
        body: body("SETTLED", ref, gross, fee + 7, settleAt, { corrects: `set-${i}` }),
      });
    }
  }

  main.sort((a, b) => (a.order - b.order) || (a.record.sourceEventId < b.record.sourceEventId ? -1 : 1));

  return {
    records: [...main.map((m) => m.record), ...trailing],
    planted: {
      transactions: spec.transactions,
      duplicateDeliveries,
      restatedDeliveries,
      corrections,
      reversals,
      feeAnomalies,
      missingSettlements,
      contradictions,
    },
  };
}
