/**
 * The exception lifecycle.
 *
 * An exception queue is a work list, not an error log. A case is opened by a
 * named reason, moves through states a person can act on, and keeps an
 * append-only history. Two properties matter and are tested:
 *
 *   1. A disposition is appended. It never replaces an earlier one, so
 *      "what did we believe on the 6th, and on what evidence" survives.
 *   2. A disposition cannot touch raw evidence. The store exposes no way to
 *      rewrite bytes, and the digest recorded on the case is checked rather
 *      than trusted.
 */

import { createHash } from 'node:crypto';
import type {
  CaseState,
  ExceptionCase,
  Explanation,
} from './types.ts';

export class DispositionRefused extends Error {}

const LEGAL: Record<CaseState, CaseState[]> = {
  OPEN: ['ASSIGNED', 'PENDING_EVIDENCE', 'RESOLVED', 'WRITTEN_OFF'],
  ASSIGNED: ['PENDING_EVIDENCE', 'RESOLVED', 'WRITTEN_OFF'],
  PENDING_EVIDENCE: ['ASSIGNED', 'RESOLVED', 'WRITTEN_OFF'],
  RESOLVED: [],
  WRITTEN_OFF: [],
};

export function openCases(explanations: Explanation[], openedAt: number): ExceptionCase[] {
  const cases: ExceptionCase[] = [];
  let n = 0;
  for (const e of explanations) {
    if (e.outcome !== 'EXCEPTION' || e.reason === null) continue;
    n += 1;
    cases.push({
      caseId: `case-${String(n).padStart(4, '0')}`,
      reason: e.reason,
      subjectId: e.subjectId,
      amountMinor: e.residualMinor,
      currency: e.currency,
      state: 'OPEN',
      openedAt,
      evidence: [...e.evidence],
      history: [],
    });
  }
  return cases;
}

export interface DispositionRequest {
  caseId: string;
  at: number;
  actor: string;
  to: CaseState;
  action: string;
  note: string;
  /** The bytes the actor was looking at, in the order the case lists them. */
  evidenceSeen: string[];
}

/**
 * Apply one disposition. Rejects an unnamed actor, an empty note, an illegal
 * transition, and a decision taken against evidence that is not the evidence
 * on the case.
 */
export function disposition(
  cases: ExceptionCase[],
  req: DispositionRequest,
  readEvidence: (locator: string) => string | undefined,
): ExceptionCase {
  const c = cases.find((x) => x.caseId === req.caseId);
  if (!c) throw new DispositionRefused(`no case ${req.caseId}`);
  if (req.actor.trim() === '') throw new DispositionRefused('a disposition needs a named actor');
  if (req.note.trim() === '') throw new DispositionRefused('a disposition needs a note');
  if (!LEGAL[c.state].includes(req.to)) {
    throw new DispositionRefused(`${c.state} -> ${req.to} is not a legal transition`);
  }

  const seen = digestOf(req.evidenceSeen);
  const held = digestOf(c.evidence.map((l) => readEvidence(l) ?? ''));
  if (seen !== held) {
    throw new DispositionRefused(
      'the evidence presented to the actor is not the evidence on the case',
    );
  }

  c.state = req.to;
  c.history.push({
    at: req.at,
    actor: req.actor,
    action: req.action,
    note: req.note,
    evidenceDigest: seen,
  });
  return c;
}

export function digestOf(parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p, 'utf8');
  return h.digest('hex').slice(0, 16);
}

export function byReason(cases: ExceptionCase[]): Array<{ reason: string; count: number; exposureMinor: number }> {
  const acc = new Map<string, { count: number; exposureMinor: number }>();
  for (const c of cases) {
    const cur = acc.get(c.reason) ?? { count: 0, exposureMinor: 0 };
    cur.count += 1;
    cur.exposureMinor += Math.abs(c.amountMinor);
    acc.set(c.reason, cur);
  }
  return [...acc.entries()]
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => (a.reason < b.reason ? -1 : 1));
}
