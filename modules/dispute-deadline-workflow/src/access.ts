// Access decisions over evidence, and retention over closed cases.
//
// Two facts shape this file, both from Google's own documentation.
//
// First, reads are not recorded unless you ask for them to be. Cloud Audit
// Logs states: "Except for BigQuery, Data Access audit logs are disabled by
// default because they can generate large volumes of data." Opening a
// cardholder's evidence packet is a read. Without that configuration there is
// no record that anybody did.
//
// Second, the record does not last. Data Access audit logs land in the
// `_Default` log bucket, whose retention period Cloud Logging gives as 30
// days, while `_Required` keeps 400 days and is "Not configurable". A dispute
// whose retention obligation is measured in years has an access history
// measured in weeks unless it is routed somewhere that keeps it.
//
// So this module keeps its own decision log. Not because the platform's is
// bad, but because the platform's is off by default and short by default, and
// the question "who looked at this evidence" is one the article claims the
// system can answer.

import type { Classification, EvidenceItem, Instant } from './types.ts';

export type Role = 'DISPUTE_ANALYST' | 'DISPUTE_APPROVER' | 'SUPPORT_AGENT' | 'AUDITOR' | 'SERVICE';

export interface Actor {
  id: string;
  role: Role;
  /** Cases this actor has been assigned. An auditor is assigned nothing. */
  assignedCases: string[];
}

export type Purpose = 'PREPARE_EVIDENCE' | 'APPROVE_PACKET' | 'CUSTOMER_ENQUIRY' | 'AUDIT' | 'SUBMIT';

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  /** Whether the actor sees the item or a redacted projection of it. */
  projection: 'FULL' | 'REDACTED' | 'NONE';
}

export const CLASSIFICATION_RANK: Record<Classification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CUSTOMER_PII: 2,
  CARDHOLDER: 3,
};

/**
 * The highest classification each role may read.
 *
 * No entry here is `CARDHOLDER`, and that is the whole of this system's claim
 * about cardholder data: it is enforced by the table rather than by a check at
 * request time. An earlier draft had both, and the mutation harness showed the
 * request-time check to be unreachable -- removing it changed no test, because
 * the ceiling had already refused every role. A guard that cannot be observed
 * to do anything is not a second line of defence, it is a comment that
 * compiles. The invariant now has a test of its own instead.
 */
export const ROLE_CEILING: Record<Role, Classification> = {
  DISPUTE_ANALYST: 'CUSTOMER_PII',
  DISPUTE_APPROVER: 'CUSTOMER_PII',
  SUPPORT_AGENT: 'INTERNAL',
  AUDITOR: 'INTERNAL',
  SERVICE: 'CUSTOMER_PII',
};

/**
 * Decide access to one evidence item.
 *
 * Assignment is checked before classification. An analyst with the right role
 * and the wrong case is denied, which is the common real failure: permissions
 * are granted per role and evidence is sensitive per case, so a role check
 * alone will happily serve one customer's documents to the person handling
 * another's.
 */
export function checkAccess(actor: Actor, item: EvidenceItem, purpose: Purpose): AccessDecision {
  if (purpose === 'AUDIT') {
    if (actor.role !== 'AUDITOR') {
      return { allowed: false, reason: 'audit purpose requires the auditor role', projection: 'NONE' };
    }
    return {
      allowed: true,
      reason: 'auditor may read metadata for any case',
      projection: 'REDACTED',
    };
  }

  if (!actor.assignedCases.includes(item.caseId)) {
    return {
      allowed: false,
      reason: `actor is not assigned to case ${item.caseId}`,
      projection: 'NONE',
    };
  }

  const ceiling = ROLE_CEILING[actor.role];
  if (CLASSIFICATION_RANK[item.classification] > CLASSIFICATION_RANK[ceiling]) {
    return {
      allowed: false,
      reason: `role ${actor.role} may not read ${item.classification} evidence`,
      projection: 'NONE',
    };
  }

  if (purpose === 'APPROVE_PACKET' && actor.role !== 'DISPUTE_APPROVER') {
    return {
      allowed: false,
      reason: 'approval requires the approver role',
      projection: 'NONE',
    };
  }

  if (purpose === 'CUSTOMER_ENQUIRY' && item.classification === 'CUSTOMER_PII') {
    return {
      allowed: true,
      reason: 'customer enquiry is served a redacted projection',
      projection: 'REDACTED',
    };
  }

  return { allowed: true, reason: 'assigned and within classification ceiling', projection: 'FULL' };
}

export interface AccessLogEntry {
  at: Instant;
  actorId: string;
  role: Role;
  itemId: string;
  caseId: string;
  purpose: Purpose;
  allowed: boolean;
  reason: string;
}

export function recordAccess(
  log: AccessLogEntry[],
  actor: Actor,
  item: EvidenceItem,
  purpose: Purpose,
  at: Instant,
): AccessDecision {
  const decision = checkAccess(actor, item, purpose);
  log.push({
    at,
    actorId: actor.id,
    role: actor.role,
    itemId: item.itemId,
    caseId: item.caseId,
    purpose,
    allowed: decision.allowed,
    reason: decision.reason,
  });
  return decision;
}
