import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  acknowledge,
  addEvidence,
  approvePacket,
  decide,
  dueRowAt,
  expire,
  isLegal,
  isTerminal,
  noteRuleChange,
  openOrRecognise,
  override,
  recordSubmission,
  stateAt,
  timeline,
} from '../src/case.ts';
import type { DisputeCase } from '../src/case.ts';
import { submit } from '../src/submission.ts';
import { at, evidence, notification, seconds } from '../src/scenarios.ts';

const RULE = 'disputes-2026.1';
const ZONES = 'synthetic-2026e';

function open(dueBySeconds: number | null = seconds('2026-10-26T03:59:59Z'), providerCaseId = 'dp-c1') {
  const cases: DisputeCase[] = [];
  const result = openOrRecognise(
    cases,
    notification({ providerCaseId, deliveryId: 'dl-1', raisedAt: '2026-10-05T09:00:00Z', dueBySeconds }),
    RULE,
    ZONES,
  );
  cases.push(result.kase);
  return { cases, kase: result.kase };
}

function receipt(caseId: string, body = 'original') {
  return evidence({ itemId: `${caseId}-receipt`, caseId, kind: 'receipt', body, capturedAt: '2026-10-06T10:00:00Z' });
}

// ---------------------------------------------------------------------------
// Duplicate notifications
// ---------------------------------------------------------------------------

test('case: a second delivery for a known case does not open a second case', () => {
  const { cases, kase } = open();
  const second = openOrRecognise(
    cases,
    notification({
      providerCaseId: kase.providerCaseId,
      deliveryId: 'dl-2',
      raisedAt: '2026-10-05T09:00:00Z',
      receivedAt: '2026-10-09T09:00:00Z',
      dueBySeconds: seconds('2026-10-26T03:59:59Z'),
    }),
    RULE,
    ZONES,
  );
  assert.equal(second.created, false);
  assert.equal(second.duplicateOf, kase.caseId);
  assert.equal(cases.length, 1);
});

test('case: a duplicate notification does not duplicate the provisional debit', () => {
  const { cases, kase } = open();
  const second = openOrRecognise(
    cases,
    notification({ providerCaseId: kase.providerCaseId, deliveryId: 'dl-2', raisedAt: '2026-10-05T09:00:00Z', receivedAt: '2026-10-09T09:00:00Z', dueBySeconds: seconds('2026-10-26T03:59:59Z') }),
    RULE,
    ZONES,
  );
  if (second.created) cases.push(second.kase);
  // Counted across every case the handler produced, not just the first one.
  // Asserting on the original object alone let a mutation that opened a second
  // case -- and therefore a second debit -- slip through green.
  const debits = cases.flatMap((c) => c.adjustments).filter((a) => a.kind === 'PROVISIONAL_DEBIT');
  assert.equal(debits.length, 1);
  assert.equal(cases.length, 1);
});

test('case: the identical delivery arriving twice is recorded and ignored', () => {
  const { cases, kase } = open();
  const again = openOrRecognise(
    cases,
    notification({ providerCaseId: kase.providerCaseId, deliveryId: 'dl-1', raisedAt: '2026-10-05T09:00:00Z', receivedAt: '2026-10-05T09:01:00Z', dueBySeconds: seconds('2026-10-26T03:59:59Z') }),
    RULE,
    ZONES,
  );
  assert.equal(again.created, false);
  assert.ok(kase.audit.some((e) => e.event === 'duplicate_delivery_ignored'));
});

test('case: a duplicate notification outside any platform deduplication window is still one case', () => {
  const { cases, kase } = open();
  // Three days later, well past the 24-hour windows the platform offers.
  const late = openOrRecognise(
    cases,
    notification({ providerCaseId: kase.providerCaseId, deliveryId: 'dl-9', raisedAt: '2026-10-05T09:00:00Z', receivedAt: '2026-10-08T09:00:00Z', dueBySeconds: seconds('2026-10-26T03:59:59Z') }),
    RULE,
    ZONES,
  );
  assert.equal(late.created, false);
  assert.ok(late.kase.seenDeliveries.length === 2);
});

// ---------------------------------------------------------------------------
// Evidence and approval
// ---------------------------------------------------------------------------

test('case: approval is refused when a required document is missing', () => {
  const { kase } = open();
  addEvidence(kase, receipt(kase.caseId), at('2026-10-06T10:00:00Z'), 'analyst-rivera');
  const result = approvePacket(kase, {
    at: at('2026-10-07T10:00:00Z'),
    actor: 'approver-okafor',
    reason: 'looks complete',
    requiredItemIds: [`${kase.caseId}-receipt`, `${kase.caseId}-delivery`],
  });
  assert.equal(result.ok, false);
  assert.match(result.note, /missing evidence/);
  assert.equal(kase.packets.length, 0);
});

test('case: evidence changed after approval sends the case back for approval', () => {
  const { kase } = open();
  addEvidence(kase, receipt(kase.caseId), at('2026-10-06T10:00:00Z'), 'analyst-rivera');
  approvePacket(kase, { at: at('2026-10-07T10:00:00Z'), actor: 'approver-okafor', reason: 'fine', requiredItemIds: [`${kase.caseId}-receipt`] });
  assert.equal(kase.state, 'AWAITING_APPROVAL');
  addEvidence(kase, receipt(kase.caseId, 'signed copy'), at('2026-10-08T10:00:00Z'), 'analyst-rivera');
  assert.equal(kase.state, 'COLLECTING_EVIDENCE');
  approvePacket(kase, { at: at('2026-10-08T11:00:00Z'), actor: 'approver-okafor', reason: 'signed copy', requiredItemIds: [`${kase.caseId}-receipt`] });
  assert.equal(kase.packets.length, 2);
  assert.equal(kase.packets[1]!.version, 2);
});

test('case: re-attaching an identical document changes nothing', () => {
  const { kase } = open();
  addEvidence(kase, receipt(kase.caseId), at('2026-10-06T10:00:00Z'), 'analyst-rivera');
  const again = addEvidence(kase, receipt(kase.caseId), at('2026-10-06T11:00:00Z'), 'analyst-rivera');
  assert.equal(again.ok, true);
  assert.equal(kase.items.length, 1);
  assert.ok(kase.audit.some((e) => e.event === 'evidence_unchanged'));
});

// ---------------------------------------------------------------------------
// Submission, acknowledgement, outcome
// ---------------------------------------------------------------------------

function prepared() {
  const { kase } = open();
  addEvidence(kase, receipt(kase.caseId), at('2026-10-06T10:00:00Z'), 'analyst-rivera');
  approvePacket(kase, { at: at('2026-10-07T10:00:00Z'), actor: 'approver-okafor', reason: 'fine', requiredItemIds: [`${kase.caseId}-receipt`] });
  return kase;
}

test('case: a submission that times out leaves the case in an unknown state', () => {
  const kase = prepared();
  const result = submit({
    packet: kase.packets[0]!,
    provider: { caseId: kase.caseId, deadline: kase.decision.deadline, submissionCount: 0, allowsResubmission: false },
    sentAt: at('2026-10-07T11:00:00Z'),
    transport: 'TIMEOUT',
    attemptId: 'sub-1',
  });
  assert.equal(result.attempt.outcome, 'UNKNOWN_TIMEOUT');
  assert.equal(result.providerRecorded, true);
  recordSubmission(kase, result.attempt, at('2026-10-07T11:00:00Z'));
  assert.equal(kase.state, 'SUBMISSION_UNKNOWN');
});

test('case: the provider acknowledging twice applies once', () => {
  const kase = prepared();
  const result = submit({
    packet: kase.packets[0]!,
    provider: { caseId: kase.caseId, deadline: kase.decision.deadline, submissionCount: 0, allowsResubmission: false },
    sentAt: at('2026-10-07T11:00:00Z'),
    transport: 'OK',
    attemptId: 'sub-1',
  });
  recordSubmission(kase, result.attempt, at('2026-10-07T11:00:00Z'));
  const ackId = result.attempt.providerAckId!;
  assert.equal(acknowledge(kase, ackId, at('2026-10-07T11:05:00Z')).ok, true);
  const repeat = acknowledge(kase, ackId, at('2026-10-09T11:05:00Z'));
  assert.equal(repeat.ok, true);
  assert.equal(kase.audit.filter((e) => e.event === 'acknowledgement_duplicate').length, 1);
  assert.equal(kase.state, 'ACKNOWLEDGED');
});

test('case: an acknowledgement arriving after the case closed is recorded and refused', () => {
  const kase = prepared();
  expire(kase, at('2026-10-27T00:00:00Z'));
  assert.equal(kase.state, 'EXPIRED_UNANSWERED');
  const late = acknowledge(kase, 'ack-late', at('2026-10-28T00:00:00Z'));
  assert.equal(late.ok, false);
  assert.ok(kase.audit.some((e) => e.event === 'acknowledgement_after_terminal'));
});

// ---------------------------------------------------------------------------
// The transition nobody commands
// ---------------------------------------------------------------------------

test('case: a case expires only once the deadline has actually passed', () => {
  const { kase } = open();
  assert.equal(expire(kase, at('2026-10-20T00:00:00Z')).ok, false);
  assert.equal(expire(kase, at('2026-10-27T00:00:00Z')).ok, true);
  assert.equal(kase.state, 'EXPIRED_UNANSWERED');
  assert.ok(kase.adjustments.some((a) => a.kind === 'LOSS_CONFIRMED'));
});

test('case: expiry is attributed to the sweep, not to a person', () => {
  const { kase } = open();
  expire(kase, at('2026-10-27T00:00:00Z'));
  const entry = kase.audit.find((e) => e.event.endsWith('->EXPIRED_UNANSWERED'))!;
  assert.equal(entry.actor, 'deadline-sweep');
  assert.equal(entry.actorKind, 'SYSTEM');
  assert.equal(kase.audit.filter((e) => e.actorKind === 'HUMAN').length, 0);
});

test('case: a case the provider permits no answer to opens terminal', () => {
  const { kase } = open(0, 'dp-c2');
  assert.equal(kase.state, 'RESPONSE_NOT_PERMITTED');
  assert.equal(isTerminal(kase.state), true);
  assert.equal(expire(kase, at('2030-01-01T00:00:00Z')).ok, false);
});

// ---------------------------------------------------------------------------
// Rule changes, overrides, legality
// ---------------------------------------------------------------------------

test('case: a rule change does not move an open case’s deadline', () => {
  const { kase } = open();
  const before = kase.decision.deadline;
  const noted = noteRuleChange(kase, 'disputes-2026.2', at('2026-10-10T00:00:00Z'));
  assert.equal(noted.ok, true);
  assert.equal(kase.decision.deadline, before);
  assert.equal(kase.decision.ruleVersion, 'disputes-2026.1');
  assert.ok(kase.audit.some((e) => e.event === 'rule_version_changed_elsewhere'));
});

test('case: a manual override requires both an actor and a reason', () => {
  const { kase } = open();
  assert.equal(override(kase, { at: at('2026-10-10T00:00:00Z'), actor: '', reason: 'because', target: 'CONCEDED' }).ok, false);
  assert.equal(override(kase, { at: at('2026-10-10T00:00:00Z'), actor: 'lead-haddad', reason: '  ', target: 'CONCEDED' }).ok, false);
  assert.equal(override(kase, { at: at('2026-10-10T00:00:00Z'), actor: 'lead-haddad', reason: 'merchant refunded', target: 'CONCEDED' }).ok, true);
  const entry = kase.audit[kase.audit.length - 1]!;
  assert.equal(entry.actor, 'lead-haddad');
  assert.equal(entry.reason, 'merchant refunded');
  assert.match(entry.event, /^override:/);
});

test('case: an override cannot reopen a terminal case', () => {
  const { kase } = open();
  expire(kase, at('2026-10-27T00:00:00Z'));
  const attempt = override(kase, { at: at('2026-10-28T00:00:00Z'), actor: 'lead-haddad', reason: 'customer complained', target: 'COLLECTING_EVIDENCE' });
  assert.equal(attempt.ok, false);
  assert.equal(kase.state, 'EXPIRED_UNANSWERED');
  assert.ok(kase.audit.some((e) => e.event === 'override_refused'));
});

test('case: an override cannot declare an outcome', () => {
  const { kase } = open();
  const attempt = override(kase, { at: at('2026-10-10T00:00:00Z'), actor: 'lead-haddad', reason: 'confident', target: 'DECIDED_IN_OUR_FAVOUR' });
  assert.equal(attempt.ok, false);
});

test('case: forbidden transitions are refused and recorded', () => {
  const { kase } = open();
  assert.equal(isLegal('OPENED', 'ACKNOWLEDGED'), false);
  const result = decide(kase, true, at('2026-10-10T00:00:00Z'), 0);
  assert.equal(result.ok, false);
  assert.ok(kase.audit.some((e) => e.event.startsWith('transition_refused:')));
});

test('case: every terminal state has no outgoing transitions', () => {
  for (const state of ['DECIDED_IN_OUR_FAVOUR', 'DECIDED_AGAINST_US', 'CONCEDED', 'RESPONSE_NOT_PERMITTED', 'EXPIRED_UNANSWERED'] as const) {
    assert.equal(isTerminal(state), true);
    assert.equal(isLegal(state, 'COLLECTING_EVIDENCE'), false);
  }
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test('case: state is recoverable from the audit trail at any past instant', () => {
  const kase = prepared();
  const result = submit({
    packet: kase.packets[0]!,
    provider: { caseId: kase.caseId, deadline: kase.decision.deadline, submissionCount: 0, allowsResubmission: false },
    sentAt: at('2026-10-07T11:00:00Z'),
    transport: 'OK',
    attemptId: 'sub-1',
  });
  recordSubmission(kase, result.attempt, at('2026-10-07T11:00:00Z'));
  assert.equal(stateAt(kase, at('2026-10-05T12:00:00Z')), 'OPENED');
  assert.equal(stateAt(kase, at('2026-10-06T12:00:00Z')), 'COLLECTING_EVIDENCE');
  assert.equal(stateAt(kase, at('2026-10-07T10:30:00Z')), 'AWAITING_APPROVAL');
  assert.equal(stateAt(kase, at('2026-10-08T00:00:00Z')), 'SUBMITTED');
});

test('case: the due row at a past instant reflects that instant, not the present', () => {
  const kase = prepared();
  expire(kase, at('2026-10-27T00:00:00Z'));
  assert.equal(dueRowAt(kase, at('2026-10-20T00:00:00Z')).terminal, false);
  assert.equal(dueRowAt(kase, at('2026-10-28T00:00:00Z')).terminal, true);
});

test('case: the audit trail is append-only and sequentially numbered', () => {
  const kase = prepared();
  const seqs = kase.audit.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  assert.ok(timeline(kase).length === kase.audit.length);
});

test('case: every audit entry names an actor and a reason', () => {
  const kase = prepared();
  for (const entry of kase.audit) {
    assert.notEqual(entry.actor.trim(), '');
    assert.notEqual(entry.reason.trim(), '');
  }
});
