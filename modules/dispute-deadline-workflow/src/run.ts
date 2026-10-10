// One worked population of cases, run end to end, deterministically.
//
// The point of running a population rather than a single case is the tally at
// the end. A deadline system's characteristic failure does not raise an error,
// so the only way to see it is to count outcomes and compare them against the
// count of errors -- which stays at zero while money is being lost.

import type { AdjustmentEvent, Instant, Packet } from './types.ts';
import {
  acknowledge,
  addEvidence,
  approvePacket,
  decide,
  expire,
  isTerminal,
  noteRuleChange,
  openOrRecognise,
  override,
  recordSubmission,
  dueRowAt,
  stateAt,
  toDueRow,
} from './case.ts';
import type { DisputeCase } from './case.ts';
import { computeDeadline, ruleSetByVersion, statusAt } from './deadline.ts';
import { reproduce } from './manifest.ts';
import { submit } from './submission.ts';
import type { ProviderState } from './submission.ts';
import { onFire, scheduleNext, sweep } from './timers.ts';
import { at, evidence, notification } from './scenarios.ts';
import { checkAccess, recordAccess } from './access.ts';
import type { AccessLogEntry, Actor } from './access.ts';
import { create as retain, placeHold, releaseHold, retainUntil, tryDelete } from './retention.ts';

const RULE = 'disputes-2026.1';
const ZONES = 'synthetic-2026e';

export interface RunTally {
  casesOpened: number;
  duplicateNotificationsSuppressed: number;
  packetsApproved: number;
  packetVersionsSupersededByLateEdits: number;
  submissionsAccepted: number;
  submissionsAcceptedPastDue: number;
  submissionsUnknown: number;
  casesExpiredUnanswered: number;
  casesNoResponsePermitted: number;
  /** Exceptions and refusals the running system actually raised. */
  errorsRaised: number;
  moneyLostMinor: number;
  moneyRecoveredMinor: number;
}

export interface RunResult {
  cases: DisputeCase[];
  tally: RunTally;
  accessLog: AccessLogEntry[];
  sweepAt: ReturnType<typeof sweep>;
  notes: string[];
}

function evidenceFor(caseId: string, suffix: string, body: string, capturedAt: string) {
  return evidence({ itemId: `${caseId}-${suffix}`, caseId, kind: suffix, body, capturedAt });
}

/**
 * Run the population.
 *
 * `now` is threaded through every call. Nothing here reads a clock, so the
 * whole run is a pure function of its literals.
 */
export function runPopulation(): RunResult {
  const cases: DisputeCase[] = [];
  const accessLog: AccessLogEntry[] = [];
  const notes: string[] = [];
  const tally: RunTally = {
    casesOpened: 0,
    duplicateNotificationsSuppressed: 0,
    packetsApproved: 0,
    packetVersionsSupersededByLateEdits: 0,
    submissionsAccepted: 0,
    submissionsAcceptedPastDue: 0,
    submissionsUnknown: 0,
    casesExpiredUnanswered: 0,
    casesNoResponsePermitted: 0,
    errorsRaised: 0,
    moneyLostMinor: 0,
    moneyRecoveredMinor: 0,
  };

  // --- Case A: the ordinary happy path, answered inside the window. --------
  const a = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2001',
      deliveryId: 'dl-a1',
      raisedAt: '2026-10-05T09:00:00Z',
      dueBySeconds: Math.floor(at('2026-10-26T03:59:59Z') / 1000),
      amountMinor: 48_900,
    }),
    RULE,
    ZONES,
  );
  cases.push(a.kase);
  tally.casesOpened += 1;
  addEvidence(a.kase, evidenceFor(a.kase.caseId, 'receipt', 'order receipt 2001', '2026-10-06T10:00:00Z'), at('2026-10-06T10:00:00Z'), 'analyst-rivera');
  addEvidence(a.kase, evidenceFor(a.kase.caseId, 'delivery', 'carrier proof 2001', '2026-10-06T11:00:00Z'), at('2026-10-06T11:00:00Z'), 'analyst-rivera');
  approvePacket(a.kase, {
    at: at('2026-10-07T15:00:00Z'),
    actor: 'approver-okafor',
    reason: 'receipt and carrier proof both present and legible',
    requiredItemIds: [`${a.kase.caseId}-receipt`, `${a.kase.caseId}-delivery`],
  });
  tally.packetsApproved += 1;
  const aPacket = a.kase.packets[a.kase.packets.length - 1]!;
  const aProvider: ProviderState = {
    caseId: a.kase.caseId,
    deadline: a.kase.decision.deadline,
    submissionCount: 0,
    allowsResubmission: false,
  };
  const aSubmit = submit({
    packet: aPacket,
    provider: aProvider,
    sentAt: at('2026-10-07T16:00:00Z'),
    transport: 'OK',
    attemptId: 'sub-a1',
  });
  recordSubmission(a.kase, aSubmit.attempt, at('2026-10-07T16:00:00Z'));
  tally.submissionsAccepted += 1;
  acknowledge(a.kase, aSubmit.attempt.providerAckId!, at('2026-10-07T16:05:00Z'));
  acknowledge(a.kase, aSubmit.attempt.providerAckId!, at('2026-10-08T09:00:00Z'));
  decide(a.kase, true, at('2026-11-02T12:00:00Z'), 0);
  tally.moneyRecoveredMinor += a.kase.amountMinor;

  // --- Case B: a duplicate notification three days later. ------------------
  const bFirst = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2002',
      deliveryId: 'dl-b1',
      raisedAt: '2026-10-05T09:30:00Z',
      dueBySeconds: Math.floor(at('2026-10-26T03:59:59Z') / 1000),
      amountMinor: 12_500,
    }),
    RULE,
    ZONES,
  );
  cases.push(bFirst.kase);
  tally.casesOpened += 1;
  const bSecond = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2002',
      deliveryId: 'dl-b2',
      raisedAt: '2026-10-05T09:30:00Z',
      receivedAt: '2026-10-08T09:30:00Z',
      dueBySeconds: Math.floor(at('2026-10-26T03:59:59Z') / 1000),
      amountMinor: 12_500,
    }),
    RULE,
    ZONES,
  );
  if (!bSecond.created) tally.duplicateNotificationsSuppressed += 1;
  const bThird = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2002',
      deliveryId: 'dl-b2',
      raisedAt: '2026-10-05T09:30:00Z',
      receivedAt: '2026-10-08T09:31:00Z',
      dueBySeconds: Math.floor(at('2026-10-26T03:59:59Z') / 1000),
      amountMinor: 12_500,
    }),
    RULE,
    ZONES,
  );
  if (!bThird.created) tally.duplicateNotificationsSuppressed += 1;
  notes.push(
    `three notifications for ${bFirst.kase.providerCaseId} produced ${cases.filter((c) => c.providerCaseId === 'dp-2002').length} case and ${bFirst.kase.adjustments.length} provisional debit`,
  );
  addEvidence(bFirst.kase, evidenceFor(bFirst.kase.caseId, 'receipt', 'order receipt 2002', '2026-10-09T10:00:00Z'), at('2026-10-09T10:00:00Z'), 'analyst-rivera');
  approvePacket(bFirst.kase, {
    at: at('2026-10-09T12:00:00Z'),
    actor: 'approver-okafor',
    reason: 'receipt sufficient for this reason code',
    requiredItemIds: [`${bFirst.kase.caseId}-receipt`],
  });
  tally.packetsApproved += 1;
  const bPacketV1 = bFirst.kase.packets[0]!;
  // The analyst finds a better document after approval.
  addEvidence(
    bFirst.kase,
    evidence({
      itemId: `${bFirst.kase.caseId}-receipt`,
      caseId: bFirst.kase.caseId,
      kind: 'receipt',
      body: 'order receipt 2002 with signature',
      capturedAt: '2026-10-10T08:00:00Z',
    }),
    at('2026-10-10T08:00:00Z'),
    'analyst-rivera',
  );
  approvePacket(bFirst.kase, {
    at: at('2026-10-10T09:00:00Z'),
    actor: 'approver-okafor',
    reason: 'replaced the receipt with the signed copy',
    requiredItemIds: [`${bFirst.kase.caseId}-receipt`],
  });
  tally.packetsApproved += 1;
  tally.packetVersionsSupersededByLateEdits += 1;
  const bPacketV2 = bFirst.kase.packets[1]!;
  notes.push(
    `case ${bFirst.kase.caseId}: packet v1 ${bPacketV1.manifestHash.slice(0, 12)} superseded by v2 ${bPacketV2.manifestHash.slice(0, 12)}`,
  );
  const bSubmit = submit({
    packet: bPacketV2,
    provider: { caseId: bFirst.kase.caseId, deadline: bFirst.kase.decision.deadline, submissionCount: 0, allowsResubmission: false },
    sentAt: at('2026-10-10T10:00:00Z'),
    transport: 'OK',
    attemptId: 'sub-b1',
  });
  recordSubmission(bFirst.kase, bSubmit.attempt, at('2026-10-10T10:00:00Z'));
  tally.submissionsAccepted += 1;
  decide(bFirst.kase, false, at('2026-11-05T12:00:00Z'), 1_500);
  tally.moneyLostMinor += bFirst.kase.amountMinor + 1_500;

  // --- Case C: the submission times out. -----------------------------------
  const c = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2003',
      deliveryId: 'dl-c1',
      raisedAt: '2026-10-06T09:00:00Z',
      dueBySeconds: Math.floor(at('2026-10-27T03:59:59Z') / 1000),
      amountMinor: 220_000,
    }),
    RULE,
    ZONES,
  );
  cases.push(c.kase);
  tally.casesOpened += 1;
  addEvidence(c.kase, evidenceFor(c.kase.caseId, 'receipt', 'order receipt 2003', '2026-10-07T10:00:00Z'), at('2026-10-07T10:00:00Z'), 'analyst-vance');
  approvePacket(c.kase, {
    at: at('2026-10-08T10:00:00Z'),
    actor: 'approver-okafor',
    reason: 'single-document packet agreed with the analyst',
    requiredItemIds: [`${c.kase.caseId}-receipt`],
  });
  tally.packetsApproved += 1;
  const cPacket = c.kase.packets[0]!;
  let cProvider: ProviderState = {
    caseId: c.kase.caseId,
    deadline: c.kase.decision.deadline,
    submissionCount: 0,
    allowsResubmission: false,
  };
  const cFirst = submit({ packet: cPacket, provider: cProvider, sentAt: at('2026-10-08T11:00:00Z'), transport: 'TIMEOUT', attemptId: 'sub-c1' });
  cProvider = cFirst.provider;
  recordSubmission(c.kase, cFirst.attempt, at('2026-10-08T11:00:00Z'));
  tally.submissionsUnknown += 1;
  // The naive repair: send it again. The provider already has one.
  const cSecond = submit({ packet: cPacket, provider: cProvider, sentAt: at('2026-10-08T11:05:00Z'), transport: 'OK', attemptId: 'sub-c2' });
  recordSubmission(c.kase, cSecond.attempt, at('2026-10-08T11:05:00Z'));
  tally.errorsRaised += 1;
  notes.push(
    `case ${c.kase.caseId}: the retry after an unknown outcome was refused as ${cSecond.attempt.outcome}; the first submission had already been recorded`,
  );
  acknowledge(c.kase, 'ack-late-c', at('2026-10-30T08:00:00Z'));
  decide(c.kase, true, at('2026-11-10T12:00:00Z'), 0);
  tally.moneyRecoveredMinor += c.kase.amountMinor;

  // --- Case D: nobody looks at it. -----------------------------------------
  const d = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2004',
      deliveryId: 'dl-d1',
      raisedAt: '2026-10-06T09:00:00Z',
      dueBySeconds: Math.floor(at('2026-10-27T03:59:59Z') / 1000),
      amountMinor: 76_400,
    }),
    RULE,
    ZONES,
  );
  cases.push(d.kase);
  tally.casesOpened += 1;
  addEvidence(d.kase, evidenceFor(d.kase.caseId, 'receipt', 'order receipt 2004', '2026-10-07T10:00:00Z'), at('2026-10-07T10:00:00Z'), 'analyst-vance');
  // No approval, no submission. The deadline arrives.
  expire(d.kase, at('2026-10-27T04:00:00Z'));
  tally.casesExpiredUnanswered += 1;
  tally.moneyLostMinor += d.kase.amountMinor;

  // --- Case E: approved in time, submitted late. ---------------------------
  const e = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2005',
      deliveryId: 'dl-e1',
      raisedAt: '2026-10-06T09:00:00Z',
      dueBySeconds: Math.floor(at('2026-10-27T03:59:59Z') / 1000),
      amountMinor: 31_000,
    }),
    RULE,
    ZONES,
  );
  cases.push(e.kase);
  tally.casesOpened += 1;
  addEvidence(e.kase, evidenceFor(e.kase.caseId, 'receipt', 'order receipt 2005', '2026-10-20T10:00:00Z'), at('2026-10-20T10:00:00Z'), 'analyst-vance');
  approvePacket(e.kase, {
    at: at('2026-10-26T22:00:00Z'),
    actor: 'approver-okafor',
    reason: 'approved on the last working evening',
    requiredItemIds: [`${e.kase.caseId}-receipt`],
  });
  tally.packetsApproved += 1;
  const ePacket = e.kase.packets[0]!;
  const eSubmit = submit({
    packet: ePacket,
    provider: { caseId: e.kase.caseId, deadline: e.kase.decision.deadline, submissionCount: 0, allowsResubmission: false },
    sentAt: at('2026-10-27T06:00:00Z'),
    transport: 'OK',
    attemptId: 'sub-e1',
  });
  recordSubmission(e.kase, eSubmit.attempt, at('2026-10-27T06:00:00Z'));
  tally.submissionsAcceptedPastDue += 1;
  notes.push(
    `case ${e.kase.caseId}: submitted ${Math.round((eSubmit.attempt.sentAt - e.kase.decision.deadline!) / 60_000)} minutes past the deadline and accepted; outcome ${eSubmit.attempt.outcome}`,
  );
  decide(e.kase, false, at('2026-11-12T12:00:00Z'), 1_500);
  tally.moneyLostMinor += e.kase.amountMinor + 1_500;

  // --- Case F: the provider permits no response. ---------------------------
  const f = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2006',
      deliveryId: 'dl-f1',
      raisedAt: '2026-10-06T09:00:00Z',
      dueBySeconds: 0,
      amountMinor: 9_900,
    }),
    RULE,
    ZONES,
  );
  cases.push(f.kase);
  tally.casesOpened += 1;
  tally.casesNoResponsePermitted += 1;
  tally.moneyLostMinor += f.kase.amountMinor;

  // --- Case G: a long deadline, beyond the scheduling horizon. -------------
  const g = openOrRecognise(
    cases,
    notification({
      providerCaseId: 'dp-2007',
      deliveryId: 'dl-g1',
      raisedAt: '2026-10-06T09:00:00Z',
      dueBySeconds: Math.floor(at('2026-12-18T04:59:59Z') / 1000),
      amountMinor: 145_000,
    }),
    RULE,
    ZONES,
  );
  cases.push(g.kase);
  tally.casesOpened += 1;
  noteRuleChange(g.kase, 'disputes-2026.2', at('2026-10-20T09:00:00Z'));
  override(g.kase, {
    at: at('2026-10-21T09:00:00Z'),
    actor: 'lead-haddad',
    reason: 'merchant has agreed to refund; we are not contesting',
    target: 'CONCEDED',
  });

  // --- Access decisions ----------------------------------------------------
  const analyst: Actor = { id: 'analyst-rivera', role: 'DISPUTE_ANALYST', assignedCases: [a.kase.caseId, bFirst.kase.caseId] };
  const otherAnalyst: Actor = { id: 'analyst-vance', role: 'DISPUTE_ANALYST', assignedCases: [c.kase.caseId, d.kase.caseId, e.kase.caseId] };
  const auditor: Actor = { id: 'auditor-shah', role: 'AUDITOR', assignedCases: [] };
  recordAccess(accessLog, analyst, a.kase.items[0]!, 'PREPARE_EVIDENCE', at('2026-10-06T10:01:00Z'));
  recordAccess(accessLog, otherAnalyst, a.kase.items[0]!, 'PREPARE_EVIDENCE', at('2026-10-06T10:02:00Z'));
  recordAccess(accessLog, auditor, a.kase.items[0]!, 'AUDIT', at('2026-11-20T10:00:00Z'));
  recordAccess(accessLog, auditor, a.kase.items[0]!, 'PREPARE_EVIDENCE', at('2026-11-20T10:01:00Z'));
  const cardholderItem = evidence({
    itemId: `${a.kase.caseId}-pan`,
    caseId: a.kase.caseId,
    kind: 'card-image',
    body: 'cardholder image',
    capturedAt: '2026-10-06T10:00:00Z',
    classification: 'CARDHOLDER',
  });
  recordAccess(accessLog, analyst, cardholderItem, 'PREPARE_EVIDENCE', at('2026-10-06T10:03:00Z'));

  // --- The sweep, as it stood on 26 October --------------------------------
  const sweepInstant = at('2026-10-26T12:00:00Z');
  const sweepAt = sweep(
    cases.map((kase) => dueRowAt(kase, sweepInstant)),
    sweepInstant,
  );

  return { cases, tally, accessLog, sweepAt, notes };
}

/** Every packet produced by the run, for the reproduction check. */
export function allPackets(result: RunResult): Packet[] {
  return result.cases.flatMap((c) => c.packets);
}

export function allAdjustments(result: RunResult): AdjustmentEvent[] {
  return result.cases.flatMap((c) => c.adjustments);
}

export function reproduceAll(result: RunResult): { total: number; matched: number } {
  const packets = allPackets(result);
  let matched = 0;
  for (const packet of packets) if (reproduce(packet).ok) matched += 1;
  return { total: packets.length, matched };
}

/** Timer-horizon arithmetic over the run's own deadlines. */
export interface HorizonRow {
  caseId: string;
  daysOut: number;
  hops: number;
  note: string;
}

export function horizonTable(result: RunResult, now: Instant): HorizonRow[] {
  return result.cases
    .map((c) => {
      const schedule = scheduleNext(dueRowAt(c, now), now);
      const target = c.decision.internalTarget;
      return {
        caseId: c.caseId,
        daysOut: target === null ? -1 : Math.round((target - now) / 86_400_000),
        hops: schedule.hopsToTarget,
        note: schedule.note,
      };
    })
    .sort((x, y) => (x.caseId < y.caseId ? -1 : 1));
}

export {
  acknowledge,
  addEvidence,
  approvePacket,
  checkAccess,
  computeDeadline,
  decide,
  dueRowAt,
  expire,
  onFire,
  openOrRecognise,
  override,
  placeHold,
  recordSubmission,
  releaseHold,
  retain,
  retainUntil,
  ruleSetByVersion,
  scheduleNext,
  statusAt,
  stateAt,
  submit,
  sweep,
  toDueRow,
  tryDelete,
};
