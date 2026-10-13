/**
 * The conservation oracle — an INDEPENDENT path.
 *
 * The recurring defect in this programme is a checker that shares arithmetic
 * with the thing it checks: when the shared helper is wrong, the error and the
 * check agree and the suite stays green. This file exists to not be that.
 *
 * It imports no parser, no matcher, no money helper and no posting rule. It
 * re-reads the raw bytes with its own field reader and its own decimal
 * conversion (`Math.round(parseFloat(x) * 100)`, which is a different
 * implementation from `src/money.ts`'s regex), and sums them its own way.
 * `tests/controls.test.ts` asserts the import list mechanically, so the
 * isolation cannot rot quietly.
 *
 * What it checks, per currency:
 *
 *   expected net  =  settled net  +  residual  +  pending
 *   provider net  =  attributed net  +  unattributed net
 *
 * Those two identities are the core invariant written as arithmetic: every
 * monetary amount is matched, pending, explained by a recorded adjustment, or
 * sitting on an owned exception. Nothing nets away.
 */

import type { Currency, Explanation } from './types.ts';

/** Independent decimal reader. Deliberately not src/money.ts's. */
function toMinor(text: string): number {
  const n = Number.parseFloat(text.trim());
  if (!Number.isFinite(n)) throw new Error(`oracle: not a number: ${text}`);
  return Math.round(n * 100);
}

export interface RawFileView {
  fileId: string;
  format: string;
  bytes: string;
}

export interface SideTotals {
  byCurrency: Map<Currency, number>;
}

function add(t: Map<Currency, number>, c: Currency, v: number): void {
  t.set(c, (t.get(c) ?? 0) + v);
}

/**
 * Sum the net of every provider row in the live raw files, reading the files
 * by field NAME rather than by column position, so a parser that mis-indexes
 * a column does not produce the same error here.
 */
export function providerNetFromRaw(files: RawFileView[]): Map<Currency, number> {
  const totals = new Map<Currency, number>();
  for (const f of files) {
    if (f.format === 'acq-csv') {
      const lines = f.bytes.split('\n').filter((l) => l.trim() !== '');
      const head = lines[0]!.split(',').map((h) => h.trim());
      const netAt = head.indexOf('net');
      const curAt = head.indexOf('currency');
      if (netAt < 0 || curAt < 0) throw new Error(`oracle: ${f.fileId} has no net/currency column`);
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]!.split(',');
        add(totals, cols[curAt]!.trim() as Currency, toMinor(cols[netAt]!));
      }
    } else if (f.format === 'psp-jsonl') {
      for (const line of f.bytes.split('\n')) {
        if (line.trim() === '') continue;
        const row = JSON.parse(line) as { net: number; amount: { currency: string } };
        add(totals, row.amount.currency as Currency, row.net);
      }
    }
  }
  return totals;
}

export interface Conservation {
  currency: Currency;
  expectedMinor: number;
  settledMinor: number;
  residualMinor: number;
  pendingMinor: number;
  holds: boolean;
}

export interface InternalCheckInput {
  /** expectationId -> [expected net, currency]. Supplied, not recomputed. */
  expected: Array<{ id: string; netMinor: number; currency: Currency }>;
  explanations: Explanation[];
  /** recordId -> [net, currency], read from the parsed records. */
  recordNet: Map<string, { netMinor: number; currency: Currency }>;
}

export function conservation(input: InternalCheckInput): Conservation[] {
  const expected = new Map<Currency, number>();
  for (const e of input.expected) add(expected, e.currency, e.netMinor);

  const settled = new Map<Currency, number>();
  const residual = new Map<Currency, number>();
  const pending = new Map<Currency, number>();

  for (const x of input.explanations) {
    if (x.side !== 'INTERNAL') continue;
    if (x.outcome === 'PENDING') {
      add(pending, x.currency, x.amountMinor);
      continue;
    }
    for (const id of x.counterpartIds) {
      const r = input.recordNet.get(id);
      if (r === undefined || r.currency !== x.currency) continue;
      add(settled, x.currency, r.netMinor);
    }
    add(residual, x.currency, x.residualMinor);
  }

  const currencies = new Set<Currency>([
    ...expected.keys(),
    ...settled.keys(),
    ...residual.keys(),
    ...pending.keys(),
  ]);
  const out: Conservation[] = [];
  for (const c of [...currencies].sort()) {
    const e = expected.get(c) ?? 0;
    const s = settled.get(c) ?? 0;
    const r = residual.get(c) ?? 0;
    const p = pending.get(c) ?? 0;
    out.push({ currency: c, expectedMinor: e, settledMinor: s, residualMinor: r, pendingMinor: p, holds: e === s + r + p });
  }
  return out;
}

export interface RowBreach {
  subjectId: string;
  currency: Currency;
  expectedMinor: number;
  settledMinor: number;
  residualMinor: number;
}

/**
 * Conservation ROW BY ROW.
 *
 * The per-currency version below is a corollary, and a weak one: two residuals
 * of equal size and opposite sign cancel inside a currency total, so a
 * currency-level check cannot see a mechanism that discards both. That is the
 * same blindness the article accuses an aggregate tie-out of, reappearing
 * inside the checker. Every row is therefore checked on its own.
 */
export function rowConservation(input: InternalCheckInput): RowBreach[] {
  const out: RowBreach[] = [];
  for (const x of input.explanations) {
    if (x.side !== 'INTERNAL') continue;
    let settled = 0;
    for (const id of x.counterpartIds) {
      const r = input.recordNet.get(id);
      if (r === undefined || r.currency !== x.currency) continue;
      settled += r.netMinor;
    }
    const residual = x.outcome === 'PENDING' ? x.amountMinor : x.residualMinor;
    if (x.amountMinor !== settled + residual) {
      out.push({
        subjectId: x.subjectId,
        currency: x.currency,
        expectedMinor: x.amountMinor,
        settledMinor: settled,
        residualMinor: residual,
      });
    }
  }
  return out;
}

export interface ProviderPartition {
  currency: Currency;
  providerMinor: number;
  attributedMinor: number;
  unattributedMinor: number;
  holds: boolean;
}

export function providerPartition(
  rawTotals: Map<Currency, number>,
  explanations: Explanation[],
  recordNet: Map<string, { netMinor: number; currency: Currency }>,
): ProviderPartition[] {
  const attributed = new Map<Currency, number>();
  const unattributed = new Map<Currency, number>();
  for (const x of explanations) {
    if (x.side === 'INTERNAL') {
      for (const id of x.counterpartIds) {
        const r = recordNet.get(id);
        if (r !== undefined) add(attributed, r.currency, r.netMinor);
      }
    } else if (x.side === 'PROVIDER') {
      const r = recordNet.get(x.subjectId);
      if (r !== undefined) add(unattributed, r.currency, r.netMinor);
    }
  }
  const currencies = new Set<Currency>([
    ...rawTotals.keys(),
    ...attributed.keys(),
    ...unattributed.keys(),
  ]);
  const out: ProviderPartition[] = [];
  for (const c of [...currencies].sort()) {
    const p = rawTotals.get(c) ?? 0;
    const a = attributed.get(c) ?? 0;
    const u = unattributed.get(c) ?? 0;
    out.push({ currency: c, providerMinor: p, attributedMinor: a, unattributedMinor: u, holds: p === a + u });
  }
  return out;
}

/**
 * The aggregate-only comparison the article argues against: one number for the
 * period, with no currency and no row identity. It is computed here so that
 * the report can show it being wrong and right at the same time.
 */
export function aggregateDifference(
  expectedNetMinor: number[],
  rawTotals: Map<Currency, number>,
  bankMinor: number[],
): {
  expected: number;
  provider: number;
  bank: number;
  difference: number;
  differenceToProvider: number;
} {
  let expected = 0;
  for (const v of expectedNetMinor) expected += v;
  let provider = 0;
  for (const v of rawTotals.values()) provider += v;
  let bank = 0;
  for (const v of bankMinor) bank += v;
  return {
    expected,
    provider,
    bank,
    difference: expected - bank,
    differenceToProvider: expected - provider,
  };
}
