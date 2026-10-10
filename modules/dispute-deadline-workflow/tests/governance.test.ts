import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CLASSIFICATION_RANK, ROLE_CEILING, checkAccess, recordAccess } from '../src/access.ts';
import type { AccessLogEntry, Actor } from '../src/access.ts';
import { create as retain, placeHold, releaseHold, retainUntil, tryDelete } from '../src/retention.ts';
import { isSettled, submit } from '../src/submission.ts';
import type { ProviderState } from '../src/submission.ts';
import { at, evidence } from '../src/scenarios.ts';
import type { Packet } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const ANALYST: Actor = { id: 'analyst-rivera', role: 'DISPUTE_ANALYST', assignedCases: ['c-1'] };
const APPROVER: Actor = { id: 'approver-okafor', role: 'DISPUTE_APPROVER', assignedCases: ['c-1'] };
const SUPPORT: Actor = { id: 'support-kim', role: 'SUPPORT_AGENT', assignedCases: ['c-1'] };
const AUDITOR: Actor = { id: 'auditor-shah', role: 'AUDITOR', assignedCases: [] };

const INTERNAL = evidence({ itemId: 'i-1', caseId: 'c-1', kind: 'receipt', body: 'receipt', capturedAt: '2026-10-06T10:00:00Z' });
const PII = evidence({ itemId: 'i-2', caseId: 'c-1', kind: 'statement', body: 'statement', capturedAt: '2026-10-06T10:00:00Z', classification: 'CUSTOMER_PII' });
const CARD = evidence({ itemId: 'i-3', caseId: 'c-1', kind: 'card-image', body: 'card', capturedAt: '2026-10-06T10:00:00Z', classification: 'CARDHOLDER' });
const OTHER_CASE = evidence({ itemId: 'i-4', caseId: 'c-2', kind: 'receipt', body: 'other', capturedAt: '2026-10-06T10:00:00Z' });

test('access: an analyst assigned to the case may read its evidence', () => {
  const decision = checkAccess(ANALYST, INTERNAL, 'PREPARE_EVIDENCE');
  assert.equal(decision.allowed, true);
  assert.equal(decision.projection, 'FULL');
});

test('access: the same analyst is refused evidence from a case they are not assigned', () => {
  const decision = checkAccess(ANALYST, OTHER_CASE, 'PREPARE_EVIDENCE');
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not assigned/);
});

test('access: assignment is checked before classification', () => {
  const decision = checkAccess(ANALYST, { ...PII, caseId: 'c-2' }, 'PREPARE_EVIDENCE');
  assert.match(decision.reason, /not assigned/);
});

test('access: a role below the classification ceiling is refused', () => {
  const decision = checkAccess(SUPPORT, PII, 'PREPARE_EVIDENCE');
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /may not read CUSTOMER_PII/);
});

test('access: cardholder-classified evidence is refused to every role', () => {
  for (const actor of [ANALYST, APPROVER, SUPPORT, AUDITOR]) {
    const decision = checkAccess(actor, CARD, 'PREPARE_EVIDENCE');
    assert.equal(decision.allowed, false, `${actor.role} was allowed cardholder evidence`);
    assert.equal(decision.projection, 'NONE');
  }
});

test('access: no role is permitted cardholder-classified evidence', () => {
  // The invariant lives in the role table, so this is where it is checked.
  for (const [role, ceiling] of Object.entries(ROLE_CEILING)) {
    assert.ok(
      CLASSIFICATION_RANK[ceiling] < CLASSIFICATION_RANK.CARDHOLDER,
      `${role} has a ceiling of ${ceiling}`,
    );
  }
});

test('access: approval requires the approver role, not merely the assignment', () => {
  assert.equal(checkAccess(ANALYST, INTERNAL, 'APPROVE_PACKET').allowed, false);
  assert.equal(checkAccess(APPROVER, INTERNAL, 'APPROVE_PACKET').allowed, true);
});

test('access: an auditor reads metadata for any case and evidence for none', () => {
  assert.equal(checkAccess(AUDITOR, INTERNAL, 'AUDIT').projection, 'REDACTED');
  assert.equal(checkAccess(AUDITOR, INTERNAL, 'PREPARE_EVIDENCE').allowed, false);
  assert.equal(checkAccess(ANALYST, INTERNAL, 'AUDIT').allowed, false);
});

test('access: a customer enquiry is served a redacted projection of PII', () => {
  const decision = checkAccess(ANALYST, PII, 'CUSTOMER_ENQUIRY');
  assert.equal(decision.allowed, true);
  assert.equal(decision.projection, 'REDACTED');
});

test('access: refusals are logged, not only grants', () => {
  const log: AccessLogEntry[] = [];
  recordAccess(log, ANALYST, INTERNAL, 'PREPARE_EVIDENCE', at('2026-10-06T10:00:00Z'));
  recordAccess(log, ANALYST, OTHER_CASE, 'PREPARE_EVIDENCE', at('2026-10-06T10:01:00Z'));
  assert.equal(log.length, 2);
  assert.equal(log.filter((e) => !e.allowed).length, 1);
  assert.equal(log[1]!.actorId, 'analyst-rivera');
});

// ---------------------------------------------------------------------------
// Retention and holds
// ---------------------------------------------------------------------------

const YEAR = 365 * 86_400_000;
const STORED = at('2026-10-06T10:00:00Z');

test('retention: an object cannot be deleted before its retention period', () => {
  const object = retain('i-1', STORED, YEAR, []);
  assert.equal(tryDelete(object, at('2027-01-01T00:00:00Z')), 'BLOCKED_BY_RETENTION');
  assert.equal(tryDelete(object, at('2027-11-01T00:00:00Z')), 'DELETED');
});

test('retention: a hold blocks deletion even after the retention period', () => {
  const held = placeHold(retain('i-1', STORED, YEAR, []), 'TEMPORARY');
  assert.equal(tryDelete(held, at('2030-01-01T00:00:00Z')), 'BLOCKED_BY_HOLD');
});

test('retention: releasing an event-based hold restarts the retention clock', () => {
  const held = placeHold(retain('i-1', STORED, YEAR, []), 'EVENT_BASED');
  const before = retainUntil(held);
  const released = releaseHold(held, 'EVENT_BASED', at('2027-06-01T00:00:00Z'));
  assert.equal(released.clockReset, true);
  assert.ok(retainUntil(released.object) > before);
  assert.equal(retainUntil(released.object), at('2027-06-01T00:00:00Z') + YEAR);
});

test('retention: releasing a temporary hold does not restart the clock', () => {
  const held = placeHold(retain('i-1', STORED, YEAR, []), 'TEMPORARY');
  const before = retainUntil(held);
  const released = releaseHold(held, 'TEMPORARY', at('2027-06-01T00:00:00Z'));
  assert.equal(released.clockReset, false);
  assert.equal(retainUntil(released.object), before);
});

test('retention: the two hold types differ only on release', () => {
  const event = placeHold(retain('i-1', STORED, YEAR, []), 'EVENT_BASED');
  const temporary = placeHold(retain('i-1', STORED, YEAR, []), 'TEMPORARY');
  assert.equal(retainUntil(event), retainUntil(temporary));
  assert.equal(tryDelete(event, at('2030-01-01T00:00:00Z')), tryDelete(temporary, at('2030-01-01T00:00:00Z')));
});

test('retention: releasing a hold that is not there changes nothing', () => {
  const object = retain('i-1', STORED, YEAR, []);
  const released = releaseHold(object, 'EVENT_BASED', at('2027-06-01T00:00:00Z'));
  assert.equal(released.clockReset, false);
  assert.equal(retainUntil(released.object), retainUntil(object));
});

test('retention: both holds must be released before deletion is possible', () => {
  let object = placeHold(placeHold(retain('i-1', STORED, YEAR, []), 'EVENT_BASED'), 'TEMPORARY');
  object = releaseHold(object, 'TEMPORARY', at('2027-01-01T00:00:00Z')).object;
  assert.equal(tryDelete(object, at('2030-01-01T00:00:00Z')), 'BLOCKED_BY_HOLD');
  object = releaseHold(object, 'EVENT_BASED', at('2027-01-01T00:00:00Z')).object;
  assert.equal(tryDelete(object, at('2030-01-01T00:00:00Z')), 'DELETED');
});

// ---------------------------------------------------------------------------
// Submission outcomes
// ---------------------------------------------------------------------------

function packet(caseId = 'c-1'): Packet {
  return {
    packetId: `${caseId}-p1`,
    caseId,
    version: 1,
    entries: [{ itemId: 'i-1', contentHash: 'abc' }],
    manifestHash: 'hash',
    ruleVersion: 'disputes-2026.1',
    deadlineBasis: 'PROVIDER_SUPPLIED',
    deadline: at('2026-10-26T03:59:59Z'),
    approvedBy: 'approver-okafor',
    approvedAt: at('2026-10-07T10:00:00Z'),
    approvalReason: 'reviewed',
  };
}

function provider(overrides: Partial<ProviderState> = {}): ProviderState {
  return { caseId: 'c-1', deadline: at('2026-10-26T03:59:59Z'), submissionCount: 0, allowsResubmission: false, ...overrides };
}

test('submission: a late submission is accepted and flagged, not rejected', () => {
  const result = submit({ packet: packet(), provider: provider(), sentAt: at('2026-10-27T06:00:00Z'), transport: 'OK', attemptId: 'a1' });
  assert.equal(result.attempt.outcome, 'ACCEPTED_LATE_DELIVERY_NOT_GUARANTEED');
  assert.equal(result.providerRecorded, true);
  assert.equal(isSettled(result.attempt.outcome), true);
});

test('submission: the provider records a submission that timed out in transit', () => {
  const result = submit({ packet: packet(), provider: provider(), sentAt: at('2026-10-20T06:00:00Z'), transport: 'TIMEOUT', attemptId: 'a1' });
  assert.equal(result.attempt.outcome, 'UNKNOWN_TIMEOUT');
  assert.equal(result.providerRecorded, true);
  assert.equal(result.provider.submissionCount, 1);
  assert.equal(isSettled(result.attempt.outcome), false);
});

test('submission: a second attempt after an unknown outcome is refused', () => {
  const first = submit({ packet: packet(), provider: provider(), sentAt: at('2026-10-20T06:00:00Z'), transport: 'TIMEOUT', attemptId: 'a1' });
  const second = submit({ packet: packet(), provider: first.provider, sentAt: at('2026-10-20T06:05:00Z'), transport: 'OK', attemptId: 'a2' });
  assert.equal(second.attempt.outcome, 'REJECTED_ALREADY_SUBMITTED');
  assert.equal(second.provider.submissionCount, 1);
});

test('submission: a provider that permits no response rejects every packet', () => {
  const result = submit({ packet: packet(), provider: provider({ deadline: null }), sentAt: at('2026-10-20T06:00:00Z'), transport: 'OK', attemptId: 'a1' });
  assert.equal(result.attempt.outcome, 'REJECTED_NOT_PERMITTED');
  assert.equal(result.providerRecorded, false);
});

test('submission: an empty packet is refused before the deadline is considered', () => {
  const empty = { ...packet(), entries: [] };
  const result = submit({ packet: empty, provider: provider(), sentAt: at('2026-10-20T06:00:00Z'), transport: 'OK', attemptId: 'a1' });
  assert.equal(result.attempt.outcome, 'REJECTED_VALIDATION');
});

test('submission: a provider that allows resubmission records both attempts', () => {
  const first = submit({ packet: packet(), provider: provider({ allowsResubmission: true }), sentAt: at('2026-10-20T06:00:00Z'), transport: 'OK', attemptId: 'a1' });
  const second = submit({ packet: packet(), provider: first.provider, sentAt: at('2026-10-21T06:00:00Z'), transport: 'OK', attemptId: 'a2' });
  assert.equal(second.attempt.outcome, 'ACCEPTED');
  assert.equal(second.provider.submissionCount, 2);
});

test('submission: the attempt carries the manifest hash it sent', () => {
  const p = packet();
  const result = submit({ packet: p, provider: provider(), sentAt: at('2026-10-20T06:00:00Z'), transport: 'OK', attemptId: 'a1' });
  assert.equal(result.attempt.manifestHash, p.manifestHash);
  assert.equal(result.attempt.packetId, p.packetId);
});
