/**
 * Heuristic suggestions.
 *
 * Nothing in this file decides anything. A suggestion is a hint for a human
 * looking at an exception queue: "these two amounts are close, on nearby
 * dates, and neither is matched". It carries a score, and the score is never
 * compared against a threshold anywhere in the pipeline.
 *
 * Keeping this separate from src/match.ts is the whole point. A heuristic that
 * can auto-apply is a matching rule with an undocumented predicate.
 */

import { netOf } from './money.ts';
import type { Expectation, NormalizedRecord } from './types.ts';

export interface Suggestion {
  expectationId: string;
  recordId: string;
  /** 0..1. Higher is closer. Not a probability and not a decision. */
  score: number;
  basis: string;
}

export interface SuggestInput {
  unmatchedExpectations: Expectation[];
  unmatchedRecords: NormalizedRecord[];
  /** Largest amount difference worth mentioning, in minor units. */
  amountWindowMinor: number;
  /** Largest date difference worth mentioning, in milliseconds. */
  dateWindowMs: number;
}

export function suggest(input: SuggestInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const e of input.unmatchedExpectations) {
    const expectedNet = netOf(e.grossMinor, e.expectedFeeMinor);
    for (const r of input.unmatchedRecords) {
      const amountGap = Math.abs(expectedNet - r.netMinor);
      const dateGap = Math.abs(e.capturedAt - r.eventTime);
      if (amountGap > input.amountWindowMinor || dateGap > input.dateWindowMs) continue;
      const amountScore = 1 - amountGap / (input.amountWindowMinor + 1);
      const dateScore = 1 - dateGap / (input.dateWindowMs + 1);
      out.push({
        expectationId: e.expectationId,
        recordId: r.recordId,
        score: Math.round(((amountScore + dateScore) / 2) * 1000) / 1000,
        basis: `net within ${amountGap} minor units and ${Math.round(dateGap / 86_400_000)} day(s)`,
      });
    }
  }
  out.sort((a, b) =>
    b.score - a.score ||
    (a.expectationId < b.expectationId ? -1 : a.expectationId > b.expectationId ? 1 : 0),
  );
  return out;
}
