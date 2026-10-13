/**
 * The posting decision.
 *
 * Article 14 owns journals, postings and balances. This file owns the
 * question that comes before them: given a settlement file, a bank entry and
 * a match, is a posting warranted at all — and on whose authority?
 *
 * One rule governs everything here:
 *
 *     A provider file is evidence. Evidence alone never produces a posting.
 *
 * A `POST_SETTLEMENT` instruction requires two independent things: a
 * deterministic match rule fired, AND a bank entry confirmed the batch that
 * the matched record belongs to. An exception produces `HOLD` until a named
 * person dispositions it, and that disposition is itself recorded.
 */

import type {
  Explanation,
  ExceptionCase,
  NormalizedRecord,
  PostingInstruction,
} from './types.ts';

export interface PostingMutations {
  /** Emit a settlement posting from a match with no confirmed deposit. */
  postWithoutBankConfirmation?: boolean;
  /** Emit a posting straight from the parsed file, bypassing the decision. */
  postFromFile?: boolean;
}

export interface PostingInput {
  explanations: Explanation[];
  records: Map<string, NormalizedRecord>;
  depositsByBatch: Map<string, string>;
  cases: ExceptionCase[];
  mutations?: PostingMutations;
}

/** The named account a residual lands in. It is never zero by omission. */
export const ADJUSTMENT_ACCOUNT = 'settlement-adjustments';

export function decidePostings(input: PostingInput): PostingInstruction[] {
  const m = input.mutations ?? {};
  const out: PostingInstruction[] = [];

  if (m.postFromFile === true) {
    // The mutation under test: the file becomes the ledger. Everything the
    // provider says is posted, matched or not, confirmed or not.
    let n = 0;
    for (const r of input.records.values()) {
      n += 1;
      out.push({
        instructionId: `pi-${String(n).padStart(5, '0')}`,
        disposition: 'POST_SETTLEMENT',
        subjectId: r.recordId,
        grossMinor: r.grossMinor,
        feeMinor: r.feeMinor,
        netMinor: r.netMinor,
        currency: r.currency,
        basis: 'provider file',
        evidence: [`${r.fileId}#${r.line}`],
      });
    }
    out.sort(byId);
    return out;
  }

  const dispositioned = new Map<string, ExceptionCase>();
  for (const c of input.cases) {
    if (c.state === 'RESOLVED' || c.state === 'WRITTEN_OFF') dispositioned.set(c.subjectId, c);
  }

  let n = 0;
  const next = (): string => {
    n += 1;
    return `pi-${String(n).padStart(5, '0')}`;
  };

  for (const e of input.explanations) {
    if (e.side !== 'INTERNAL') continue;

    const counterparts = e.counterpartIds
      .map((id) => input.records.get(id))
      .filter((r): r is NormalizedRecord => r !== undefined);
    const batches = new Set(counterparts.map((r) => r.batchId));
    const confirmedBy: string[] = [];
    for (const b of batches) {
      const dep = input.depositsByBatch.get(b);
      if (dep !== undefined) confirmedBy.push(dep);
    }
    const confirmed = batches.size > 0 && confirmedBy.length === batches.size;

    let gross = 0;
    let fee = 0;
    let net = 0;
    for (const r of counterparts) {
      if (r.currency !== e.currency) continue;
      gross += r.grossMinor;
      fee += r.feeMinor;
      net += r.netMinor;
    }

    if (e.outcome === 'PENDING') {
      out.push({
        instructionId: next(),
        disposition: 'DEFER',
        subjectId: e.subjectId,
        grossMinor: 0,
        feeMinor: 0,
        netMinor: 0,
        currency: e.currency,
        basis: 'no settlement evidence inside the cutoff; the position is open, not wrong',
        evidence: [],
      });
      continue;
    }

    if (e.outcome === 'EXCEPTION') {
      const decision = dispositioned.get(e.subjectId);
      if (decision === undefined) {
        out.push({
          instructionId: next(),
          disposition: 'HOLD',
          subjectId: e.subjectId,
          grossMinor: 0,
          feeMinor: 0,
          netMinor: 0,
          currency: e.currency,
          basis: `exception ${e.reason}; no posting until a disposition exists`,
          evidence: e.evidence,
        });
        continue;
      }
      const last = decision.history[decision.history.length - 1]!;
      out.push({
        instructionId: next(),
        disposition: 'POST_ADJUSTMENT',
        subjectId: e.subjectId,
        grossMinor: 0,
        feeMinor: 0,
        netMinor: e.residualMinor,
        currency: e.currency,
        basis: `${ADJUSTMENT_ACCOUNT}; disposition ${last.action} by ${last.actor} on case ${decision.caseId}`,
        evidence: [...e.evidence, `case:${decision.caseId}`],
      });
      continue;
    }

    if (!confirmed && m.postWithoutBankConfirmation !== true) {
      out.push({
        instructionId: next(),
        disposition: 'DEFER',
        subjectId: e.subjectId,
        grossMinor: 0,
        feeMinor: 0,
        netMinor: 0,
        currency: e.currency,
        basis: `matched by ${e.rule} but no bank entry confirms ${[...batches].join(',')}`,
        evidence: e.evidence,
      });
      continue;
    }

    out.push({
      instructionId: next(),
      disposition: 'POST_SETTLEMENT',
      subjectId: e.subjectId,
      grossMinor: gross,
      feeMinor: fee,
      netMinor: net,
      currency: e.currency,
      basis: `matched by ${e.rule}; confirmed by ${confirmedBy.join(',') || 'nothing'}`,
      evidence: [...e.evidence, ...confirmedBy.map((d) => `bank:${d}`)],
    });

    if (e.residualMinor !== 0) {
      out.push({
        instructionId: next(),
        disposition: 'POST_ADJUSTMENT',
        subjectId: e.subjectId,
        grossMinor: 0,
        feeMinor: 0,
        netMinor: e.residualMinor,
        currency: e.currency,
        basis: `${ADJUSTMENT_ACCOUNT}; within-tolerance difference recorded rather than absorbed`,
        evidence: e.evidence,
      });
    }
  }

  out.sort(byId);
  return out;
}

function byId(a: PostingInstruction, b: PostingInstruction): number {
  return a.instructionId < b.instructionId ? -1 : a.instructionId > b.instructionId ? 1 : 0;
}

/** Every instruction that would move money in the ledger. */
export function settlementTotal(instructions: PostingInstruction[], currency: string): number {
  let total = 0;
  for (const i of instructions) {
    if (i.currency !== currency) continue;
    if (i.disposition === 'POST_SETTLEMENT' || i.disposition === 'POST_ADJUSTMENT') total += i.netMinor;
  }
  return total;
}
