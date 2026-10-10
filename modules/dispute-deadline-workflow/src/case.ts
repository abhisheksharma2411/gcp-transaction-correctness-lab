// The dispute case: one durable identity, one deadline, one audit timeline.
//
// Article 13 owns durable state-machine design -- legal transitions, versions,
// recovery from recorded state. This file applies that design rather than
// re-deriving it, and spends its attention on the part that is specific to a
// dispute: the transitions are driven by a clock somebody else owns, and the
// expensive transition is the one nobody commands.

import type {
  AdjustmentEvent,
  AuditEntry,
  CaseState,
  DeadlineDecision,
  EvidenceItem,
  Instant,
  Packet,
  ProviderNotification,
  SubmissionAttempt,
} from './types.ts';
import { TERMINAL_STATES } from './types.ts';
import { computeDeadline, ruleSetByVersion, statusAt } from './deadline.ts';
import { approve } from './manifest.ts';
import type { DueRow } from './timers.ts';

/** Legal transitions. Anything absent is refused and recorded as refused. */
const TRANSITIONS: Record<CaseState, CaseState[]> = {
  OPENED: ['COLLECTING_EVIDENCE', 'CONCEDED', 'RESPONSE_NOT_PERMITTED', 'EXPIRED_UNANSWERED'],
  COLLECTING_EVIDENCE: ['AWAITING_APPROVAL', 'CONCEDED', 'EXPIRED_UNANSWERED'],
  AWAITING_APPROVAL: [
    'COLLECTING_EVIDENCE',
    'SUBMITTED',
    'SUBMISSION_UNKNOWN',
    'CONCEDED',
    'EXPIRED_UNANSWERED',
  ],
  SUBMITTED: ['ACKNOWLEDGED', 'DECIDED_IN_OUR_FAVOUR', 'DECIDED_AGAINST_US'],
  SUBMISSION_UNKNOWN: ['SUBMITTED', 'ACKNOWLEDGED', 'EXPIRED_UNANSWERED', 'DECIDED_AGAINST_US'],
  ACKNOWLEDGED: ['DECIDED_IN_OUR_FAVOUR', 'DECIDED_AGAINST_US'],
  DECIDED_IN_OUR_FAVOUR: [],
  DECIDED_AGAINST_US: [],
  CONCEDED: [],
  RESPONSE_NOT_PERMITTED: [],
  EXPIRED_UNANSWERED: [],
};

export function isTerminal(state: CaseState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isLegal(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface DisputeCase {
  caseId: string;
  providerCaseId: string;
  paymentRef: string;
  amountMinor: number;
  currency: string;
  reasonCode: string;
  state: CaseState;
  decision: DeadlineDecision;
  openedAt: Instant;
  /** Delivery identifiers already seen, for duplicate notifications. */
  seenDeliveries: string[];
  items: EvidenceItem[];
  packets: Packet[];
  attempts: SubmissionAttempt[];
  adjustments: AdjustmentEvent[];
  audit: AuditEntry[];
  /** Bumped whenever the schedule is rewritten. */
  generation: number;
  /** Acknowledgement identifiers already applied. */
  acknowledgements: string[];
}

export interface CommandResult {
  ok: boolean;
  note: string;
}

function log(
  kase: DisputeCase,
  at: Instant,
  actor: string,
  actorKind: 'SYSTEM' | 'HUMAN' | 'PROVIDER',
  event: string,
  reason: string,
): void {
  kase.audit.push({
    seq: kase.audit.length + 1,
    caseId: kase.caseId,
    at,
    actor,
    actorKind,
    event,
    reason,
    ruleVersion: kase.decision.ruleVersion,
  });
}

function transition(
  kase: DisputeCase,
  to: CaseState,
  at: Instant,
  actor: string,
  actorKind: 'SYSTEM' | 'HUMAN' | 'PROVIDER',
  reason: string,
): CommandResult {
  if (!isLegal(kase.state, to)) {
    log(kase, at, actor, actorKind, `transition_refused:${kase.state}->${to}`, reason);
    return { ok: false, note: `illegal transition ${kase.state} -> ${to}` };
  }
  const from = kase.state;
  kase.state = to;
  kase.generation += 1;
  log(kase, at, actor, actorKind, `transition:${from}->${to}`, reason);
  return { ok: true, note: `${from} -> ${to}` };
}

// ---------------------------------------------------------------------------
// Case creation and duplicate notifications
// ---------------------------------------------------------------------------

export interface OpenResult {
  kase: DisputeCase;
  created: boolean;
  duplicateOf: string | null;
  note: string;
}

/**
 * Open a case from a provider notification, or recognise a duplicate.
 *
 * The durable identity is the provider's case identifier, never the delivery
 * identifier. Those are different things and only one of them is stable:
 * Workflows' published limits give the "Deduplication window ... to ensure
 * exactly-once processing when triggering a workflow execution with events" as
 * 24 hours, and Cloud Tasks gives its "Task deduplication window" as "Up to 24
 * hours". A provider that re-notifies on day three is outside both windows and
 * will start a second process unless the business identity is the thing being
 * checked. Article 12 is the general treatment; this is the one boundary that
 * matters here.
 */
export function openOrRecognise(
  existing: DisputeCase[],
  notification: ProviderNotification,
  ruleVersion: string,
  zoneTableVersion: string,
): OpenResult {
  const match = existing.find((c) => c.providerCaseId === notification.providerCaseId);
  if (match) {
    if (match.seenDeliveries.includes(notification.deliveryId)) {
      log(match, notification.receivedAt, 'notification-handler', 'SYSTEM', 'duplicate_delivery_ignored', `delivery ${notification.deliveryId} already applied`);
      return { kase: match, created: false, duplicateOf: match.caseId, note: 'same delivery seen again' };
    }
    match.seenDeliveries.push(notification.deliveryId);
    log(match, notification.receivedAt, 'notification-handler', 'SYSTEM', 'duplicate_case_notification', `new delivery ${notification.deliveryId} for known case ${notification.providerCaseId}`);
    return {
      kase: match,
      created: false,
      duplicateOf: match.caseId,
      note: 'new delivery for a case already open',
    };
  }

  const rules = ruleSetByVersion(ruleVersion);
  const decision = computeDeadline({ notification, rules, zoneTableVersion });
  const caseId = `case-${notification.providerCaseId}`;
  const kase: DisputeCase = {
    caseId,
    providerCaseId: notification.providerCaseId,
    paymentRef: notification.paymentRef,
    amountMinor: notification.amountMinor,
    currency: notification.currency,
    reasonCode: notification.reasonCode,
    state: 'OPENED',
    decision,
    openedAt: notification.receivedAt,
    seenDeliveries: [notification.deliveryId],
    items: [],
    packets: [],
    attempts: [],
    adjustments: [],
    audit: [],
    generation: 1,
    acknowledgements: [],
  };
  log(kase, notification.receivedAt, 'notification-handler', 'SYSTEM', 'case_opened', `basis ${decision.basis}`);

  kase.adjustments.push({
    eventId: `${caseId}-adj-1`,
    caseId,
    kind: 'PROVISIONAL_DEBIT',
    amountMinor: notification.amountMinor,
    currency: notification.currency,
    occurredAt: notification.receivedAt,
    basis: 'dispute opened; funds held pending outcome',
  });

  if (decision.basis === 'NO_RESPONSE_PERMITTED') {
    transition(kase, 'RESPONSE_NOT_PERMITTED', notification.receivedAt, 'notification-handler', 'SYSTEM', 'provider states no response is accepted');
  }

  return { kase, created: true, duplicateOf: null, note: 'case opened' };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function addEvidence(kase: DisputeCase, item: EvidenceItem, at: Instant, actor: string): CommandResult {
  if (isTerminal(kase.state)) {
    log(kase, at, actor, 'HUMAN', 'evidence_rejected', 'case is terminal');
    return { ok: false, note: 'case is terminal' };
  }
  if (kase.state === 'OPENED') {
    transition(kase, 'COLLECTING_EVIDENCE', at, actor, 'HUMAN', 'first evidence item attached');
  }
  const index = kase.items.findIndex((x) => x.itemId === item.itemId);
  if (index >= 0) {
    const previous = kase.items[index]!;
    if (previous.contentHash === item.contentHash) {
      log(kase, at, actor, 'HUMAN', 'evidence_unchanged', item.itemId);
      return { ok: true, note: 'identical item re-attached; nothing changed' };
    }
    kase.items[index] = item;
    log(kase, at, actor, 'HUMAN', 'evidence_replaced', `${item.itemId} content changed`);
    if (kase.state === 'AWAITING_APPROVAL') {
      transition(kase, 'COLLECTING_EVIDENCE', at, actor, 'HUMAN', 'evidence changed after approval was requested');
    }
    return { ok: true, note: 'item replaced' };
  }
  kase.items.push(item);
  log(kase, at, actor, 'HUMAN', 'evidence_added', item.itemId);
  if (kase.state === 'AWAITING_APPROVAL') {
    transition(kase, 'COLLECTING_EVIDENCE', at, actor, 'HUMAN', 'evidence added after approval was requested');
  }
  return { ok: true, note: 'item added' };
}

export interface ApproveCommand {
  at: Instant;
  actor: string;
  reason: string;
  /** Items the approver believes they are approving, by id. */
  requiredItemIds: string[];
}

export function approvePacket(kase: DisputeCase, command: ApproveCommand): CommandResult {
  if (isTerminal(kase.state)) return { ok: false, note: 'case is terminal' };
  const missing = command.requiredItemIds.filter((id) => !kase.items.some((x) => x.itemId === id));
  if (missing.length > 0) {
    log(kase, command.at, command.actor, 'HUMAN', 'approval_refused', `missing evidence: ${missing.join(', ')}`);
    return { ok: false, note: `missing evidence: ${missing.join(', ')}` };
  }
  if (kase.state === 'OPENED' || kase.state === 'COLLECTING_EVIDENCE') {
    transition(kase, 'AWAITING_APPROVAL', command.at, command.actor, 'HUMAN', 'evidence set presented for approval');
  }
  const result = approve({
    caseId: kase.caseId,
    items: kase.items,
    decision: kase.decision,
    approvedBy: command.actor,
    approvedAt: command.at,
    approvalReason: command.reason,
    existing: kase.packets,
  });
  if (!result.ok) {
    log(kase, command.at, command.actor, 'HUMAN', 'approval_refused', result.error);
    return { ok: false, note: result.error };
  }
  if (result.created) {
    kase.packets.push(result.packet);
    log(kase, command.at, command.actor, 'HUMAN', `packet_approved:v${result.packet.version}`, `${command.reason} (manifest ${result.packet.manifestHash.slice(0, 12)})`);
    return { ok: true, note: `packet v${result.packet.version} approved` };
  }
  log(kase, command.at, command.actor, 'HUMAN', 'approval_noop', 'evidence set unchanged since the last approval');
  return { ok: true, note: 'evidence unchanged; existing packet stands' };
}

// ---------------------------------------------------------------------------
// Submission, acknowledgement, outcome
// ---------------------------------------------------------------------------

export function recordSubmission(kase: DisputeCase, attempt: SubmissionAttempt, at: Instant): CommandResult {
  kase.attempts.push(attempt);
  if (attempt.outcome === 'UNKNOWN_TIMEOUT') {
    log(kase, at, 'submission-adapter', 'SYSTEM', 'submission_unknown', attempt.attemptId);
    return transition(kase, 'SUBMISSION_UNKNOWN', at, 'submission-adapter', 'SYSTEM', 'transport timed out; provider state unknown');
  }
  if (attempt.outcome === 'REJECTED_NOT_PERMITTED') {
    log(kase, at, 'submission-adapter', 'SYSTEM', 'submission_rejected', attempt.outcome);
    return { ok: false, note: attempt.outcome };
  }
  if (attempt.outcome === 'REJECTED_VALIDATION' || attempt.outcome === 'REJECTED_ALREADY_SUBMITTED') {
    log(kase, at, 'submission-adapter', 'SYSTEM', 'submission_rejected', attempt.outcome);
    return { ok: false, note: attempt.outcome };
  }
  const late = attempt.outcome === 'ACCEPTED_LATE_DELIVERY_NOT_GUARANTEED';
  const result = transition(kase, 'SUBMITTED', at, 'submission-adapter', 'SYSTEM', late ? 'accepted after the deadline; delivery not guaranteed' : 'accepted before the deadline');
  if (late) {
    log(kase, at, 'submission-adapter', 'SYSTEM', 'submitted_past_due', 'provider recorded the submission as past due');
  }
  return result;
}

export function acknowledge(kase: DisputeCase, ackId: string, at: Instant): CommandResult {
  if (kase.acknowledgements.includes(ackId)) {
    log(kase, at, 'provider', 'PROVIDER', 'acknowledgement_duplicate', ackId);
    return { ok: true, note: 'acknowledgement already applied' };
  }
  kase.acknowledgements.push(ackId);
  if (isTerminal(kase.state)) {
    log(kase, at, 'provider', 'PROVIDER', 'acknowledgement_after_terminal', `${ackId} arrived in state ${kase.state}`);
    return { ok: false, note: `acknowledgement arrived after the case reached ${kase.state}` };
  }
  return transition(kase, 'ACKNOWLEDGED', at, 'provider', 'PROVIDER', `acknowledgement ${ackId}`);
}

export function decide(kase: DisputeCase, won: boolean, at: Instant, feeMinor: number): CommandResult {
  const target: CaseState = won ? 'DECIDED_IN_OUR_FAVOUR' : 'DECIDED_AGAINST_US';
  const result = transition(kase, target, at, 'provider', 'PROVIDER', won ? 'decided in our favour' : 'decided against us');
  if (!result.ok) return result;
  kase.adjustments.push({
    eventId: `${kase.caseId}-adj-${kase.adjustments.length + 1}`,
    caseId: kase.caseId,
    kind: won ? 'PROVISIONAL_DEBIT_REVERSED' : 'LOSS_CONFIRMED',
    amountMinor: kase.amountMinor,
    currency: kase.currency,
    occurredAt: at,
    basis: won ? 'dispute decided in our favour' : 'dispute decided against us',
  });
  if (feeMinor > 0) {
    kase.adjustments.push({
      eventId: `${kase.caseId}-adj-${kase.adjustments.length + 1}`,
      caseId: kase.caseId,
      kind: 'DISPUTE_FEE',
      amountMinor: feeMinor,
      currency: kase.currency,
      occurredAt: at,
      basis: 'provider dispute fee',
    });
  }
  return result;
}

/** The transition nobody commands. */
export function expire(kase: DisputeCase, now: Instant): CommandResult {
  if (isTerminal(kase.state)) return { ok: false, note: 'already terminal' };
  if (statusAt(kase.decision, now) !== 'PAST_DEADLINE') {
    return { ok: false, note: 'deadline has not passed' };
  }
  const result = transition(kase, 'EXPIRED_UNANSWERED', now, 'deadline-sweep', 'SYSTEM', 'deadline passed with no accepted submission');
  if (result.ok) {
    kase.adjustments.push({
      eventId: `${kase.caseId}-adj-${kase.adjustments.length + 1}`,
      caseId: kase.caseId,
      kind: 'LOSS_CONFIRMED',
      amountMinor: kase.amountMinor,
      currency: kase.currency,
      occurredAt: now,
      basis: 'deadline passed with no accepted submission',
    });
  }
  return result;
}

export interface OverrideCommand {
  at: Instant;
  actor: string;
  reason: string;
  target: CaseState;
}

/**
 * A manual override. It requires an actor and a reason, it is recorded as an
 * override rather than as an ordinary transition, and it cannot reopen a
 * terminal case. The last of those is the one worth enforcing in code: a
 * dispute that has been decided against you is a financial fact, and an
 * operator who can quietly move it back to `COLLECTING_EVIDENCE` can quietly
 * make the ledger disagree with the provider.
 */
export function override(kase: DisputeCase, command: OverrideCommand): CommandResult {
  if (command.actor.trim() === '') return { ok: false, note: 'override requires an actor' };
  if (command.reason.trim() === '') return { ok: false, note: 'override requires a reason' };
  if (isTerminal(kase.state)) {
    log(kase, command.at, command.actor, 'HUMAN', 'override_refused', `case is terminal in ${kase.state}`);
    return { ok: false, note: 'a terminal case cannot be reopened by override' };
  }
  if (command.target === 'DECIDED_IN_OUR_FAVOUR' || command.target === 'DECIDED_AGAINST_US') {
    log(kase, command.at, command.actor, 'HUMAN', 'override_refused', 'an outcome is the provider’s to state');
    return { ok: false, note: 'an outcome cannot be set by override' };
  }
  const from = kase.state;
  kase.state = command.target;
  kase.generation += 1;
  log(kase, command.at, command.actor, 'HUMAN', `override:${from}->${command.target}`, command.reason);
  return { ok: true, note: `override ${from} -> ${command.target}` };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Replay the audit trail to recover the state the case was in at an instant.
 *
 * This is the property that makes a deadline system auditable after the fact.
 * "Was this case still open on the twenty-seventh?" is a question about the
 * past, and answering it from the current row gives the wrong answer for every
 * case that has since closed. The transition entries carry their own
 * timestamps, so the past states are recoverable without a second store.
 */
export function stateAt(kase: DisputeCase, instant: Instant): CaseState {
  let state: CaseState = 'OPENED';
  for (const entry of kase.audit) {
    if (entry.at > instant) break;
    const marker = entry.event.startsWith('transition:')
      ? entry.event.slice('transition:'.length)
      : entry.event.startsWith('override:')
        ? entry.event.slice('override:'.length)
        : null;
    if (marker === null) continue;
    const arrow = marker.indexOf('->');
    if (arrow < 0) continue;
    state = marker.slice(arrow + 2) as CaseState;
  }
  return state;
}

const ANSWERED_STATES: readonly CaseState[] = ['SUBMITTED', 'ACKNOWLEDGED'];

/** The due row as it stood at an instant, rather than as it stands now. */
export function dueRowAt(kase: DisputeCase, instant: Instant): DueRow {
  const state = stateAt(kase, instant);
  return {
    caseId: kase.caseId,
    internalTarget: kase.decision.internalTarget,
    deadline: kase.decision.deadline,
    terminal: isTerminal(state),
    answered: ANSWERED_STATES.includes(state),
    generation: kase.generation,
  };
}

export function toDueRow(kase: DisputeCase): DueRow {
  return {
    caseId: kase.caseId,
    internalTarget: kase.decision.internalTarget,
    deadline: kase.decision.deadline,
    terminal: isTerminal(kase.state),
    answered: ANSWERED_STATES.includes(kase.state),
    generation: kase.generation,
  };
}

/**
 * Re-apply a rule change to a case that is already open.
 *
 * The deadline is not recomputed. A new rule set applies to cases opened after
 * it, and to an open case it applies only as an annotation, so that an
 * operator reading the case can see that the rules moved and that this case
 * was not moved with them. Recomputing would be the dangerous choice: it would
 * change a date that a packet has already been approved against, and the
 * approval would then attest to a deadline that was never the one in force.
 */
export function noteRuleChange(kase: DisputeCase, newRuleVersion: string, at: Instant): CommandResult {
  if (newRuleVersion === kase.decision.ruleVersion) {
    return { ok: false, note: 'rule version unchanged' };
  }
  log(kase, at, 'rule-loader', 'SYSTEM', 'rule_version_changed_elsewhere', `cases opened after this point use ${newRuleVersion}; this case keeps ${kase.decision.ruleVersion}`);
  return { ok: true, note: `noted; case keeps ${kase.decision.ruleVersion}` };
}

export function timeline(kase: DisputeCase): string[] {
  return kase.audit.map(
    (entry) => `${entry.seq}. ${new Date(entry.at).toISOString().replace('.000Z', 'Z')} [${entry.actorKind}:${entry.actor}] ${entry.event} -- ${entry.reason}`,
  );
}
