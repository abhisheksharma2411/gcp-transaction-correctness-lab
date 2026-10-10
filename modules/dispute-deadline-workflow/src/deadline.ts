// The deadline engine.
//
// One rule governs everything here: a deadline you do not control is evidence,
// not arithmetic. When the provider states the date, that date is the answer
// and the rule set is only there to explain it. The derived window exists for
// the case where the provider states nothing, and it is clearly labelled as a
// guess whenever it is used.

import type {
  DeadlineBasis,
  DeadlineDecision,
  Instant,
  ProviderNotification,
  RuleSet,
} from './types.ts';
import { calendarByVersion } from './calendar.ts';
import { endOfWindow } from './calendar.ts';
import { render, zoneTableByVersion } from './zones.ts';

export const RULES_V1: RuleSet = {
  version: 'disputes-2026.1',
  description: 'Five business days, New York calendar, 17:00 cutoff, 24-hour safety margin.',
  fallbackBusinessDays: 5,
  calendarVersion: 'ny-2026.1',
  cutoffLocalMinutes: 17 * 60,
  safetyMarginMinutes: 24 * 60,
};

/** A later revision: a longer window, a revised calendar and a wider margin. */
export const RULES_V2: RuleSet = {
  version: 'disputes-2026.2',
  description: 'Seven business days, revised New York calendar, 17:00 cutoff, 72-hour safety margin.',
  fallbackBusinessDays: 7,
  calendarVersion: 'ny-2026.2',
  cutoffLocalMinutes: 17 * 60,
  safetyMarginMinutes: 72 * 60,
};

/** The same contract operated out of Winnipeg. */
export const RULES_CA_V1: RuleSet = {
  version: 'disputes-ca-2026.1',
  description: 'Five business days, Winnipeg calendar, 17:00 cutoff, 24-hour safety margin.',
  fallbackBusinessDays: 5,
  calendarVersion: 'wpg-2026.1',
  cutoffLocalMinutes: 17 * 60,
  safetyMarginMinutes: 24 * 60,
};

/** And out of Lord Howe Island, where the daylight shift is half an hour. */
export const RULES_LHI_V1: RuleSet = {
  version: 'disputes-lhi-2026.1',
  description: 'Five business days, Lord Howe calendar, 17:00 cutoff, 24-hour safety margin.',
  fallbackBusinessDays: 5,
  calendarVersion: 'lhi-2026.1',
  cutoffLocalMinutes: 17 * 60,
  safetyMarginMinutes: 24 * 60,
};

/** A Friday weekend and an 18:00 cutoff. */
export const RULES_GULF_V1: RuleSet = {
  version: 'disputes-gulf-2026.1',
  description: 'Five business days, Gulf calendar with a Friday weekend, 18:00 cutoff.',
  fallbackBusinessDays: 5,
  calendarVersion: 'gulf-2026.1',
  cutoffLocalMinutes: 18 * 60,
  safetyMarginMinutes: 24 * 60,
};

export const RULE_SETS: RuleSet[] = [
  RULES_V1,
  RULES_V2,
  RULES_CA_V1,
  RULES_LHI_V1,
  RULES_GULF_V1,
];

export function ruleSetByVersion(version: string): RuleSet {
  const found = RULE_SETS.find((r) => r.version === version);
  if (!found) throw new Error(`unknown rule version: ${version}`);
  return found;
}

export interface DeadlineInput {
  notification: ProviderNotification;
  rules: RuleSet;
  zoneTableVersion: string;
}

/**
 * The sentinel problem.
 *
 * A provider that is not accepting a response has to say so somehow, and the
 * field it says it in is the same field that otherwise carries a date. Stripe's
 * API reference documents its own choice for the Dispute object: `due_by` is
 * "Date by which evidence must be submitted in order to successfully challenge
 * dispute. Will be 0 if the customer's bank or credit card company doesn't
 * allow a response for this particular dispute."
 *
 * Zero seconds since the epoch is 1 January 1970. An engine that parses the
 * field as a timestamp turns "you may not respond to this" into "you were due
 * fifty-six years ago", and every downstream query for overdue cases then
 * reports it as a miss. The sentinel is not a date and is never treated as
 * one.
 */
export function classifyProviderDueBy(dueBySeconds: number | null): DeadlineBasis {
  if (dueBySeconds === null) return 'DERIVED_FROM_RULES';
  if (dueBySeconds === 0) return 'NO_RESPONSE_PERMITTED';
  if (dueBySeconds < 0) throw new Error(`provider due_by is negative: ${dueBySeconds}`);
  return 'PROVIDER_SUPPLIED';
}

export function computeDeadline(input: DeadlineInput): DeadlineDecision {
  const { notification, rules, zoneTableVersion } = input;
  const table = zoneTableByVersion(zoneTableVersion);
  const calendar = calendarByVersion(rules.calendarVersion);
  const basis = classifyProviderDueBy(notification.dueBySeconds);
  const trace: string[] = [
    `rule set ${rules.version}`,
    `zone table ${table.version}`,
    `calendar ${calendar.version} (${calendar.calendarId}, ${calendar.zone})`,
    `provider due_by field: ${notification.dueBySeconds === null ? 'absent' : String(notification.dueBySeconds)}`,
    `basis ${basis}`,
  ];

  if (basis === 'NO_RESPONSE_PERMITTED') {
    trace.push('due_by is the zero sentinel, not a date; no deadline exists');
    return {
      basis,
      ruleVersion: rules.version,
      calendarVersion: calendar.version,
      zoneTableVersion: table.version,
      deadline: null,
      internalTarget: null,
      trace,
    };
  }

  let deadline: Instant;
  if (basis === 'PROVIDER_SUPPLIED') {
    deadline = notification.dueBySeconds! * 1000;
    trace.push(`provider deadline ${render(deadline)} taken as stated`);
    if (deadline <= notification.raisedAt) {
      trace.push('provider deadline is not after the raise time; case opens already overdue');
    }
  } else {
    const window = endOfWindow(
      table,
      calendar,
      notification.raisedAt,
      rules.fallbackBusinessDays,
      rules.cutoffLocalMinutes,
    );
    deadline = window.instant;
    trace.push(`no provider deadline; derived ${rules.fallbackBusinessDays} business days`);
    trace.push(...window.steps);
    trace.push(`derived deadline ${render(deadline)}`);
  }

  const internalTarget = deadline - rules.safetyMarginMinutes * 60_000;
  trace.push(
    `internal target ${render(internalTarget)} (deadline minus ${rules.safetyMarginMinutes} minutes)`,
  );

  return {
    basis,
    ruleVersion: rules.version,
    calendarVersion: calendar.version,
    zoneTableVersion: table.version,
    deadline,
    internalTarget,
    trace,
  };
}

export type DeadlineStatus = 'NO_DEADLINE' | 'COMFORTABLE' | 'DUE' | 'PAST_DEADLINE';

/**
 * Where a case stands against its own deadline at a given instant.
 *
 * `DUE` is the state that matters. It means the internal target has passed
 * while the real deadline has not, which is the only window in which anybody
 * can still do something about it. A system that reports only `PAST_DEADLINE`
 * is reporting losses, not risks.
 */
export function statusAt(decision: DeadlineDecision, now: Instant): DeadlineStatus {
  if (decision.deadline === null || decision.internalTarget === null) return 'NO_DEADLINE';
  if (now >= decision.deadline) return 'PAST_DEADLINE';
  if (now >= decision.internalTarget) return 'DUE';
  return 'COMFORTABLE';
}

export function minutesRemaining(decision: DeadlineDecision, now: Instant): number | null {
  if (decision.deadline === null) return null;
  return Math.floor((decision.deadline - now) / 60_000);
}
