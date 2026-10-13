/**
 * The fixture corpus.
 *
 * Everything here is synthetic and deterministic: a linear congruential
 * generator with a fixed seed, fixed dates, and planted defects whose
 * arithmetic is chosen so that they CANCEL IN AGGREGATE. That cancellation is
 * the experiment. A period-level tie-out of this corpus reconciles to zero
 * while seven transaction-level defects sit inside it.
 *
 * No card numbers, no names, no real merchant identifiers.
 */

import { minorToDecimal } from './money.ts';
import { isoDateToMs } from './parsers.ts';
import type { Currency, Expectation, Kind, RawFile } from './types.ts';

const D = (iso: string): number => isoDateToMs(iso);

/** Fee model. A parameter of the model, not a published fee schedule. */
export function modelFee(grossMinor: number, kind: Kind): number {
  if (kind === 'REFUND') return 0;
  if (kind === 'CHARGEBACK') return 1500;
  return Math.round(Math.abs(grossMinor) * 0.029) + 30;
}

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  between(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
}

interface Row {
  txnId: string;
  merchantRef: string;
  kind: Kind;
  grossMinor: number;
  feeMinor: number;
  currency: Currency;
  eventDate: string;
  batchId: string;
}

interface BatchPlan {
  batchId: string;
  source: string;
  payoutRef: string;
  businessDate: string;
  fundingDate: string;
  /** Internal expectations for this batch. */
  expected: Row[];
  /** What the provider actually reports. May differ from `expected`. */
  reported: Row[];
  /** Rows whose stated net is deliberately wrong in the first file version. */
  statedNetOverride: Map<string, number>;
}

function row(
  txnId: string,
  merchantRef: string,
  kind: Kind,
  grossMinor: number,
  eventDate: string,
  batchId: string,
  currency: Currency = 'USD',
  feeMinor?: number,
): Row {
  return {
    txnId,
    merchantRef,
    kind,
    grossMinor,
    feeMinor: feeMinor ?? modelFee(grossMinor, kind),
    currency,
    eventDate,
    batchId,
  };
}

/** Build the four batches, their expectations and their provider reports. */
function plan(): BatchPlan[] {
  const rng = new Lcg(20260319);
  const plans: BatchPlan[] = [];

  const shape: Array<{
    batchId: string;
    source: string;
    payoutRef: string;
    date: string;
    funding: string;
    captures: number;
    refunds: number;
    refundScale: number;
  }> = [
    { batchId: 'bt-01', source: 'acquirer', payoutRef: 'po-001', date: '2026-03-02', funding: '2026-03-04', captures: 48, refunds: 4, refundScale: 1 },
    { batchId: 'bt-02', source: 'acquirer', payoutRef: 'po-002', date: '2026-03-03', funding: '2026-03-05', captures: 46, refunds: 4, refundScale: 1 },
    { batchId: 'bt-03', source: 'psp', payoutRef: 'po-003', date: '2026-03-04', funding: '2026-03-05', captures: 44, refunds: 5, refundScale: 1 },
    // A batch whose refunds exceed its captures. The provider pays a negative
    // amount, which the bank records as a debit rather than a deposit.
    { batchId: 'bt-04', source: 'psp', payoutRef: 'po-004', date: '2026-03-05', funding: '2026-03-06', captures: 8, refunds: 14, refundScale: 4 },
  ];

  let seq = 0;
  for (const s of shape) {
    const expected: Row[] = [];
    for (let i = 0; i < s.captures; i++) {
      seq += 1;
      const gross = rng.between(500, 25000);
      expected.push(row(`tx-${String(seq).padStart(4, '0')}`, `ord-${String(seq).padStart(4, '0')}`, 'CAPTURE', gross, s.date, s.batchId));
    }
    for (let i = 0; i < s.refunds; i++) {
      seq += 1;
      const gross = -rng.between(500, 9000) * s.refundScale;
      expected.push(row(`tx-${String(seq).padStart(4, '0')}`, `ord-${String(seq).padStart(4, '0')}`, 'REFUND', gross, s.date, s.batchId));
    }
    plans.push({
      batchId: s.batchId,
      source: s.source,
      payoutRef: s.payoutRef,
      businessDate: s.date,
      fundingDate: s.funding,
      expected,
      reported: expected.map((r) => ({ ...r })),
      statedNetOverride: new Map(),
    });
  }
  return plans;
}

const BT = (plans: BatchPlan[], id: string): BatchPlan => {
  const found = plans.find((p) => p.batchId === id);
  if (!found) throw new Error(`no batch ${id}`);
  return found;
};

/** Plant the defects. Each one is named in docs/MODEL.md and in the report. */
function plantDefects(plans: BatchPlan[]): void {
  const b1 = BT(plans, 'bt-01');
  const b2 = BT(plans, 'bt-02');
  const b3 = BT(plans, 'bt-03');

  // One capture settled as two provider rows whose grosses and fees sum to the
  // expectation. Many provider records to one internal record.
  const split = row('tx-9001', 'ord-9001', 'CAPTURE', 18000, '2026-03-02', 'bt-01');
  b1.expected.push(split);
  b1.reported.push(row('tx-9001a', 'ord-9001', 'CAPTURE', 10000, '2026-03-02', 'bt-01', 'USD', 322));
  b1.reported.push(row('tx-9001b', 'ord-9001', 'CAPTURE', 8000, '2026-03-02', 'bt-01', 'USD', 230));

  // D1: an expectation the provider never reports. Net 43,665.
  const missing = row('tx-9101', 'ord-9101', 'CAPTURE', 45000, '2026-03-03', 'bt-02');
  b2.expected.push(missing);

  // D2: a provider row nothing internal knows about, of exactly the same net.
  // In aggregate these two cancel to the cent.
  b2.reported.push(row('tx-9102', 'ord-9102', 'CAPTURE', 45000, '2026-03-03', 'bt-02'));

  // D3 and D4: a fee overcharged by 120 on one row and undercharged by 120 on
  // another. The period's fee total is correct; neither row is.
  const over = b2.expected[0]!;
  const under = b2.expected[1]!;
  const overRep = b2.reported.find((r) => r.txnId === over.txnId)!;
  const underRep = b2.reported.find((r) => r.txnId === under.txnId)!;
  overRep.feeMinor = over.feeMinor + 120;
  underRep.feeMinor = under.feeMinor - 120;

  // Two rows whose fee differs by one minor unit, one each way. Both are
  // inside the tolerance; both residuals are recorded rather than absorbed.
  const tolOver = b1.expected[0]!;
  const tolUnder = b1.expected[1]!;
  b1.reported.find((r) => r.txnId === tolOver.txnId)!.feeMinor = tolOver.feeMinor + 1;
  b1.reported.find((r) => r.txnId === tolUnder.txnId)!.feeMinor = tolUnder.feeMinor - 1;

  // D5: a capture settled in part. Expected net 48,520; reported net 29,100.
  const partial = row('tx-9201', 'ord-9201', 'CAPTURE', 50000, '2026-03-04', 'bt-03');
  b3.expected.push(partial);
  b3.reported.push(row('tx-9201', 'ord-9201', 'CAPTURE', 30000, '2026-03-04', 'bt-03', 'USD', 900));

  // D6: a provider row delivered twice inside one file, net 19,420 — chosen so
  // that it cancels the shortfall from D5 exactly.
  const twice = row('tx-9202', 'ord-9202', 'CAPTURE', 20031, '2026-03-04', 'bt-03');
  b3.expected.push(twice);
  b3.reported.push({ ...twice });
  b3.reported.push({ ...twice });

  // D7: the same amount reported in the wrong currency. A sum that ignores
  // currency cannot see this at all.
  // The internal record carries the wrong presentment currency. The provider
  // and the bank agree with each other; only our expectation is in EUR.
  const fx = row('tx-9301', 'ord-9301', 'CAPTURE', 25000, '2026-03-04', 'bt-03', 'EUR');
  b3.expected.push(fx);
  b3.reported.push({ ...fx, currency: 'USD' });

  // D8: a refund captured internally on the 3rd, settled on the 5th, and
  // carried by the provider under an identifier of its own.
  const lateRefund = row('tx-9401', 'ord-9401', 'REFUND', -6400, '2026-03-03', 'bt-03');
  b3.expected.push(lateRefund);
  b3.reported.push({ ...lateRefund, txnId: 'rf-9401', eventDate: '2026-03-05' });

  // D15: a capture the provider re-issued under a new identifier on the same
  // day. Only the reference, the amount and the currency connect the two.
  const reissued = row('tx-9501', 'ord-9501', 'CAPTURE', 7700, '2026-03-04', 'bt-03');
  b3.expected.push(reissued);
  b3.reported.push({ ...reissued, txnId: 'ch-9501-r2' });

  // D9: one row in bt-03's first file states a net that contradicts its own
  // gross and fee. The corrected file fixes the stated net and nothing else.
  b3.statedNetOverride.set(b3.reported[0]!.txnId, 1);
}

function renderAcqCsv(rows: Row[], v2: boolean, overrides: Map<string, number>): string {
  const header = v2
    ? 'txn_id,merchant_ref,type,gross,fee,fee_breakdown,net,currency,transaction_date,batch_id'
    : 'txn_id,merchant_ref,type,gross,fee,net,currency,event_date,batch_id';
  const lines = [header];
  for (const r of rows) {
    const net = r.grossMinor - r.feeMinor + (overrides.get(r.txnId) ?? 0);
    const cells = v2
      ? [r.txnId, r.merchantRef, r.kind, minorToDecimal(r.grossMinor, r.currency), minorToDecimal(r.feeMinor, r.currency), 'processing', minorToDecimal(net, r.currency), r.currency, r.eventDate, r.batchId]
      : [r.txnId, r.merchantRef, r.kind, minorToDecimal(r.grossMinor, r.currency), minorToDecimal(r.feeMinor, r.currency), minorToDecimal(net, r.currency), r.currency, r.eventDate, r.batchId];
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function renderPspJsonl(rows: Row[], overrides: Map<string, number>): string {
  const lines: string[] = [];
  for (const r of rows) {
    const net = r.grossMinor - r.feeMinor + (overrides.get(r.txnId) ?? 0);
    const fees = r.feeMinor === 0
      ? []
      : [
          { type: 'processing', value: r.feeMinor - 4 },
          { type: 'scheme', value: 4 },
        ];
    lines.push(
      JSON.stringify({
        id: r.txnId,
        reference: r.merchantRef,
        kind: r.kind,
        amount: { value: r.grossMinor, currency: r.currency },
        fees,
        net,
        settlement: { batch: r.batchId, eventDate: r.eventDate },
      }),
    );
  }
  return `${lines.join('\n')}\n`;
}

function batchNet(p: BatchPlan): number {
  let total = 0;
  for (const r of p.reported) total += r.grossMinor - r.feeMinor;
  return total;
}

function renderSummary(plans: BatchPlan[]): string {
  const header = 'batch_id,business_date,gross,fee,net,currency,funding_date,payout_ref';
  const lines = [header];
  for (const p of plans) {
    let gross = 0;
    let fee = 0;
    for (const r of p.reported) {
      gross += r.grossMinor;
      fee += r.feeMinor;
    }
    lines.push(
      [p.batchId, p.businessDate, minorToDecimal(gross, 'USD'), minorToDecimal(fee, 'USD'), minorToDecimal(gross - fee, 'USD'), 'USD', p.fundingDate, p.payoutRef].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface Corpus {
  expectations: Expectation[];
  files: RawFile[];
  /** Named rows the tests refer to, so a test never guesses an id. */
  landmarks: Record<string, string>;
}

export function buildCorpus(): Corpus {
  const plans = plan();
  plantDefects(plans);

  const expectations: Expectation[] = [];
  for (const p of plans) {
    for (const r of p.expected) {
      expectations.push({
        expectationId: `exp-${r.txnId.slice(3)}`,
        merchantRef: r.merchantRef,
        source: p.source,
        providerTxnId: r.txnId,
        kind: r.kind,
        grossMinor: r.grossMinor,
        expectedFeeMinor: r.feeMinor,
        currency: r.currency,
        capturedAt: D(r.eventDate),
      });
    }
  }

  const b1 = BT(plans, 'bt-01');
  const b2 = BT(plans, 'bt-02');
  const b3 = BT(plans, 'bt-03');
  const b4 = BT(plans, 'bt-04');

  const b1Bytes = renderAcqCsv(b1.reported, false, b1.statedNetOverride);
  // The same name, a different body, and no declaration that it corrects
  // anything. This must not overwrite the first arrival.
  const b1Tampered = renderAcqCsv(
    b1.reported.map((r, i) => (i === 0 ? { ...r, grossMinor: r.grossMinor + 100 } : r)),
    false,
    b1.statedNetOverride,
  );
  const b2Bytes = renderAcqCsv(b2.reported, true, b2.statedNetOverride);
  const b3Wrong = renderPspJsonl(b3.reported, b3.statedNetOverride);
  const b3Right = renderPspJsonl(b3.reported, new Map());
  const b4Bytes = renderPspJsonl(b4.reported, new Map());

  const acqSummary = renderSummary([b1, b2]);
  const pspSummary = renderSummary([b3, b4]);

  const deposits = {
    accountId: 'acct-0001',
    entries: [
      { entryRef: 'dep-001', amountMinor: batchNet(b1), currency: 'USD', valueDate: '2026-03-04', remittance: 'PAYOUT po-001' },
      // One deposit covering two settlement batches from two sources.
      { entryRef: 'dep-002', amountMinor: batchNet(b2) + batchNet(b3), currency: 'USD', valueDate: '2026-03-05', remittance: 'PAYOUT po-002 po-003' },
      // A negative payout: the provider debits the account.
      { entryRef: 'dep-003', amountMinor: batchNet(b4), currency: 'USD', valueDate: '2026-03-06', remittance: 'PAYOUT po-004' },
    ],
  };

  const files: RawFile[] = [
    { source: 'acquirer', declaredName: 'detail-2026-03-02.csv', bytes: b1Bytes, format: 'acq-csv', formatVersion: '1', receivedAt: D('2026-03-03') },
    // The same file again, byte for byte. Providers re-send.
    { source: 'acquirer', declaredName: 'detail-2026-03-02.csv', bytes: b1Bytes, format: 'acq-csv', formatVersion: '1', receivedAt: D('2026-03-03') + 3_600_000 },
    // The same bytes under a different name. Only the digest catches this.
    { source: 'acquirer', declaredName: 'detail-2026-03-02-resend.csv', bytes: b1Bytes, format: 'acq-csv', formatVersion: '1', receivedAt: D('2026-03-03') + 5_400_000 },
    // The same name, different bytes, no declared correction.
    { source: 'acquirer', declaredName: 'detail-2026-03-02.csv', bytes: b1Tampered, format: 'acq-csv', formatVersion: '1', receivedAt: D('2026-03-03') + 7_200_000 },
    // A schema change: the acquirer adds a column and renames another.
    { source: 'acquirer', declaredName: 'detail-2026-03-03.csv', bytes: b2Bytes, format: 'acq-csv', formatVersion: '2', receivedAt: D('2026-03-04') },
    { source: 'psp', declaredName: 'settlement-2026-03-04.jsonl', bytes: b3Wrong, format: 'psp-jsonl', formatVersion: '1', receivedAt: D('2026-03-05') },
    // The provider reissues the file, declaring what it replaces.
    { source: 'psp', declaredName: 'settlement-2026-03-04.v2.jsonl', bytes: b3Right, format: 'psp-jsonl', formatVersion: '1', receivedAt: D('2026-03-06'), corrects: 'settlement-2026-03-04.jsonl' },
    { source: 'acquirer', declaredName: 'summary-2026-03-05.csv', bytes: acqSummary, format: 'acq-summary-csv', formatVersion: '1', receivedAt: D('2026-03-05') },
    { source: 'psp', declaredName: 'summary-2026-03-06.csv', bytes: pspSummary, format: 'acq-summary-csv', formatVersion: '1', receivedAt: D('2026-03-06') },
    { source: 'bank', declaredName: 'statement-2026-03-06.json', bytes: `${JSON.stringify(deposits, null, 2)}\n`, format: 'bank-json', formatVersion: '1', receivedAt: D('2026-03-07') },
    // The last detail file arrives three days after the money did.
    { source: 'psp', declaredName: 'settlement-2026-03-05.jsonl', bytes: b4Bytes, format: 'psp-jsonl', formatVersion: '1', receivedAt: D('2026-03-09') },
  ];

  return {
    expectations,
    files,
    landmarks: {
      missingProviderRecord: 'exp-9101',
      unknownToLedger: 'tx-9102',
      feeOvercharged: `exp-${b2.expected[0]!.txnId.slice(3)}`,
      feeUndercharged: `exp-${b2.expected[1]!.txnId.slice(3)}`,
      partialSettlement: 'exp-9201',
      duplicatedProviderRow: 'exp-9202',
      currencyMismatch: 'exp-9301',
      refundAcrossDays: 'exp-9401',
      reissuedByProvider: 'exp-9501',
      splitCapture: 'exp-9001',
      arithmeticInconsistent: b3.reported[0]!.txnId,
      toleranceOver: `exp-${b1.expected[0]!.txnId.slice(3)}`,
      toleranceUnder: `exp-${b1.expected[1]!.txnId.slice(3)}`,
      lateBatch: 'bt-04',
      negativeDeposit: 'dep-003',
      multiBatchDeposit: 'dep-002',
    },
  };
}
