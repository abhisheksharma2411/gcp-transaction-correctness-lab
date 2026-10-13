/**
 * Deterministic matching.
 *
 * Five rules, applied in a fixed order, each producing an explanation that
 * names the rule, the evidence and any amount the rule could not account for.
 * Nothing here is a guess: a rule either fires on an exact predicate or it
 * does not fire. Heuristics live in src/suggest.ts and never decide anything.
 */

import { netOf } from './money.ts';
import type {
  BankEntry,
  BatchSummary,
  Currency,
  Expectation,
  Explanation,
  ExceptionReason,
  MatchRuleId,
  NormalizedRecord,
  RunConfig,
} from './types.ts';

export interface MatchMutations {
  /** Compare amounts without comparing currency. */
  ignoreCurrency?: boolean;
  /** Absorb a within-tolerance difference instead of recording the residual. */
  absorbResidual?: boolean;
  /** Treat heuristic suggestions as matches. */
  applySuggestions?: boolean;
}

export interface MatchInput {
  expectations: Expectation[];
  records: NormalizedRecord[];
  summaries: BatchSummary[];
  bank: BankEntry[];
  /**
   * True when settlement detail covering this expectation's batch is live
   * inside the cutoff. False means the evidence has not had its chance yet,
   * which is a pending position rather than a defect.
   */
  evidenceArrivedFor: (e: Expectation) => boolean;
  config: RunConfig;
  mutations?: MatchMutations;
}

export interface MatchResult {
  explanations: Explanation[];
  /** recordId -> expectationId, for every record a rule consumed. */
  consumed: Map<string, string>;
  depositsByBatch: Map<string, string>;
}

function locate(r: NormalizedRecord): string {
  return `${r.fileId}#${r.line}`;
}

function sameCurrency(a: Currency, b: Currency, m: MatchMutations): boolean {
  return m.ignoreCurrency === true || a === b;
}

/**
 * Apply the rules. The order is M1, M2, M3, M4, M5 and then the currency
 * check; moving the currency check earlier would turn a real defect into a
 * match, which is what the negative control demonstrates.
 */
export function match(input: MatchInput): MatchResult {
  const m = input.mutations ?? {};
  const tol = input.config.tolerance.feeToleranceMinor;
  const explanations: Explanation[] = [];
  const consumed = new Map<string, string>();

  const byRef = new Map<string, NormalizedRecord[]>();
  for (const r of input.records) {
    const list = byRef.get(r.merchantRef);
    if (list) list.push(r);
    else byRef.set(r.merchantRef, [r]);
  }
  const free = (r: NormalizedRecord): boolean => !consumed.has(r.recordId);

  // --- record-level arithmetic check, independent of any match -------------
  // A provider that contradicts itself is an exception before anything is
  // compared to it. The record is not repaired and not discarded.
  const inconsistent = new Set<string>();
  for (const r of input.records) {
    if (r.netMinor !== netOf(r.grossMinor, r.feeMinor)) {
      inconsistent.add(r.recordId);
      explanations.push({
        subjectId: r.recordId,
        side: 'PROVIDER',
        outcome: 'EXCEPTION',
        rule: null,
        reason: 'PROVIDER_ARITHMETIC_INCONSISTENT',
        amountMinor: r.netMinor,
        currency: r.currency,
        residualMinor: r.netMinor - netOf(r.grossMinor, r.feeMinor),
        counterpartIds: [],
        evidence: [locate(r)],
        text: `${r.providerTxnId}: stated net ${r.netMinor} is not gross ${r.grossMinor} less fee ${r.feeMinor}`,
      });
    }
  }

  for (const e of input.expectations) {
    const candidates = (byRef.get(e.merchantRef) ?? []).filter(free);
    const expectedNet = netOf(e.grossMinor, e.expectedFeeMinor);

    const push = (
      outcome: Explanation['outcome'],
      rule: MatchRuleId | null,
      reason: ExceptionReason | null,
      residual: number,
      used: NormalizedRecord[],
      text: string,
    ): void => {
      for (const r of used) consumed.set(r.recordId, e.expectationId);
      explanations.push({
        subjectId: e.expectationId,
        side: 'INTERNAL',
        outcome,
        rule,
        reason,
        amountMinor: expectedNet,
        currency: e.currency,
        residualMinor: m.absorbResidual === true && outcome !== 'EXCEPTION' ? 0 : residual,
        counterpartIds: used.map((r) => r.recordId),
        evidence: used.map(locate),
        text,
      });
    };

    const classifyFee = (r: NormalizedRecord, rule: MatchRuleId): void => {
      const feeDiff = r.feeMinor - e.expectedFeeMinor;
      if (feeDiff === 0) {
        push('MATCHED', rule, null, 0, [r], `${rule}: ${r.providerTxnId} settles ${e.expectationId} at the expected fee`);
      } else if (Math.abs(feeDiff) <= tol) {
        push('MATCHED_WITH_ADJUSTMENT', rule, null, feeDiff, [r], `${rule}: ${r.providerTxnId} settles ${e.expectationId}; fee differs by ${feeDiff}, within tolerance ${tol}, residual recorded`);
      } else {
        push('EXCEPTION', rule, 'FEE_VARIANCE_BEYOND_TOLERANCE', feeDiff, [r], `${rule}: ${r.providerTxnId} settles ${e.expectationId}; fee differs by ${feeDiff}, beyond tolerance ${tol}`);
      }
    };

    // M1 — the provider's own transaction identifier.
    const m1 = candidates.find(
      (r) =>
        r.providerTxnId === e.providerTxnId &&
        r.kind === e.kind &&
        r.grossMinor === e.grossMinor &&
        sameCurrency(r.currency, e.currency, m) &&
        !inconsistent.has(r.recordId),
    );
    if (m1) {
      classifyFee(m1, 'M1_PROVIDER_TXN_ID');
      continue;
    }

    // M2 — merchant reference, amount and currency, when the ids differ.
    const m2 = candidates.find(
      (r) =>
        r.kind === e.kind &&
        r.grossMinor === e.grossMinor &&
        sameCurrency(r.currency, e.currency, m) &&
        Math.abs(r.eventTime - e.capturedAt) <= 86_400_000 &&
        !inconsistent.has(r.recordId),
    );
    if (m2) {
      classifyFee(m2, 'M2_REF_AMOUNT_CURRENCY');
      continue;
    }

    // M3 — a refund or reversal that settles on a different day.
    const m3 = candidates.find(
      (r) =>
        r.kind === e.kind &&
        (e.kind === 'REFUND' || e.kind === 'CHARGEBACK') &&
        r.grossMinor === e.grossMinor &&
        sameCurrency(r.currency, e.currency, m) &&
        !inconsistent.has(r.recordId),
    );
    if (m3) {
      classifyFee(m3, 'M3_REFUND_ACROSS_DAYS');
      continue;
    }

    // M4 — several provider rows summing to one expectation.
    const sameRef = candidates.filter(
      (r) => r.kind === e.kind && sameCurrency(r.currency, e.currency, m) && !inconsistent.has(r.recordId),
    );
    if (sameRef.length > 1) {
      let gross = 0;
      let fee = 0;
      for (const r of sameRef) {
        gross += r.grossMinor;
        fee += r.feeMinor;
      }
      if (gross === e.grossMinor) {
        const feeDiff = fee - e.expectedFeeMinor;
        if (Math.abs(feeDiff) <= tol) {
          push(feeDiff === 0 ? 'MATCHED' : 'MATCHED_WITH_ADJUSTMENT', 'M4_SPLIT_TO_ONE', null, feeDiff, sameRef, `M4_SPLIT_TO_ONE: ${sameRef.length} provider rows sum to ${e.expectationId}`);
        } else {
          push('EXCEPTION', 'M4_SPLIT_TO_ONE', 'FEE_VARIANCE_BEYOND_TOLERANCE', feeDiff, sameRef, `M4_SPLIT_TO_ONE: ${sameRef.length} rows sum to ${e.expectationId}; fee differs by ${feeDiff}`);
        }
        continue;
      }
    }

    // M5 — part of the expectation settled, the rest neither settled nor
    // refused. The shortfall is named, never netted away.
    const m5 = sameRef.find(
      (r) => Math.sign(r.grossMinor) === Math.sign(e.grossMinor) && Math.abs(r.grossMinor) < Math.abs(e.grossMinor),
    );
    if (m5) {
      const residual = expectedNet - netOf(m5.grossMinor, m5.feeMinor);
      push('EXCEPTION', 'M5_PARTIAL_SETTLEMENT', 'PARTIAL_SETTLEMENT', residual, [m5], `M5_PARTIAL_SETTLEMENT: ${m5.providerTxnId} settles ${m5.grossMinor} of ${e.grossMinor} for ${e.expectationId}; shortfall ${residual}`);
      continue;
    }

    // A record that agrees on everything except the currency.
    const fx = candidates.find((r) => r.kind === e.kind && r.grossMinor === e.grossMinor && r.currency !== e.currency);
    if (fx) {
      push('EXCEPTION', null, 'CURRENCY_MISMATCH', expectedNet, [fx], `${fx.providerTxnId} reports ${fx.currency} where ${e.expectationId} expects ${e.currency}`);
      continue;
    }

    // Nothing. Whether that is an exception or a legitimate pending position
    // depends on whether the evidence has had its chance to arrive.
    if (input.evidenceArrivedFor(e)) {
      push('EXCEPTION', null, 'MISSING_PROVIDER_RECORD', expectedNet, [], `no provider record for ${e.expectationId} in a batch whose detail file has been ingested`);
    } else {
      push('PENDING', null, null, 0, [], `${e.expectationId} awaits a settlement file; none is live inside the cutoff`);
    }
  }

  // --- provider rows no rule consumed --------------------------------------
  const consumedSignature = new Set<string>();
  for (const r of input.records) {
    if (consumed.has(r.recordId)) consumedSignature.add(signature(r));
  }
  for (const r of input.records) {
    if (consumed.has(r.recordId) || inconsistent.has(r.recordId)) continue;
    const duplicate = consumedSignature.has(signature(r));
    explanations.push({
      subjectId: r.recordId,
      side: 'PROVIDER',
      outcome: 'EXCEPTION',
      rule: null,
      reason: duplicate ? 'DUPLICATE_PROVIDER_RECORD' : 'UNKNOWN_TO_LEDGER',
      amountMinor: r.netMinor,
      currency: r.currency,
      residualMinor: r.netMinor,
      counterpartIds: [],
      evidence: [locate(r)],
      text: duplicate
        ? `${r.providerTxnId} repeats a row already matched, with identical gross, fee and currency`
        : `${r.providerTxnId} appears in a provider file and in no internal record`,
    });
  }

  // --- deposits -------------------------------------------------------------
  const batchByPayout = new Map<string, BatchSummary>();
  for (const s of input.summaries) batchByPayout.set(s.payoutRef, s);
  const depositsByBatch = new Map<string, string>();

  for (const entry of input.bank) {
    const refs = entry.remittance.replace(/^PAYOUT\s+/, '').split(/\s+/).filter((x) => x !== '');
    const batches = refs.map((ref) => batchByPayout.get(ref)).filter((s): s is BatchSummary => s !== undefined);
    let expected = 0;
    for (const s of batches) expected += s.netMinor;
    const residual = entry.amountMinor - expected;
    if (batches.length === refs.length && residual === 0) {
      for (const s of batches) depositsByBatch.set(s.batchId, entry.entryRef);
      explanations.push({
        subjectId: entry.entryRef,
        side: 'BANK',
        outcome: 'MATCHED',
        rule: null,
        reason: null,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        residualMinor: 0,
        counterpartIds: batches.map((s) => s.batchId),
        evidence: [`${entry.fileId}#${entry.line}`, ...batches.map((s) => `${s.fileId}:${s.batchId}`)],
        text: `${entry.entryRef} settles ${batches.map((s) => s.batchId).join(' and ')} at the stated net`,
      });
    } else {
      explanations.push({
        subjectId: entry.entryRef,
        side: 'BANK',
        outcome: 'EXCEPTION',
        rule: null,
        reason: 'DEPOSIT_UNEXPLAINED',
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        residualMinor: residual,
        counterpartIds: batches.map((s) => s.batchId),
        evidence: [`${entry.fileId}#${entry.line}`],
        text: `${entry.entryRef} of ${entry.amountMinor} does not equal the ${expected} summarised for ${refs.join(' and ')}`,
      });
    }
  }

  for (const s of input.summaries) {
    if (depositsByBatch.has(s.batchId) || s.fundingDate > input.config.cutoff) continue;
    explanations.push({
      subjectId: s.batchId,
      side: 'BANK',
      outcome: 'EXCEPTION',
      rule: null,
      reason: 'BATCH_NOT_DEPOSITED',
      amountMinor: s.netMinor,
      currency: s.currency,
      residualMinor: s.netMinor,
      counterpartIds: [],
      evidence: [`${s.fileId}:${s.batchId}`],
      text: `${s.batchId} was funded on or before the cutoff and no bank entry references ${s.payoutRef}`,
    });
  }

  explanations.sort((a, b) => (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0));
  return { explanations, consumed, depositsByBatch };
}

function signature(r: NormalizedRecord): string {
  return `${r.providerTxnId}|${r.kind}|${r.grossMinor}|${r.feeMinor}|${r.currency}`;
}
