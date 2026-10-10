import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CALENDAR_NY_V1,
  addBusinessDays,
  calendarByVersion,
  endOfWindow,
  isBusinessDay,
} from '../src/calendar.ts';
import {
  classifyProviderDueBy,
  computeDeadline,
  minutesRemaining,
  ruleSetByVersion,
  statusAt,
} from '../src/deadline.ts';
import { ZONE_TABLE_CURRENT, render } from '../src/zones.ts';
import { DEADLINE_FIXTURES, at, notification, seconds } from '../src/scenarios.ts';

function decide(id: string) {
  const fixture = DEADLINE_FIXTURES.find((f) => f.id === id)!;
  return computeDeadline({
    notification: fixture.notification,
    rules: ruleSetByVersion(fixture.ruleVersion),
    zoneTableVersion: fixture.zoneTableVersion,
  });
}

// ---------------------------------------------------------------------------
// The sentinel
// ---------------------------------------------------------------------------

test('deadline: a due_by of zero is not a date', () => {
  assert.equal(classifyProviderDueBy(0), 'NO_RESPONSE_PERMITTED');
  assert.equal(classifyProviderDueBy(null), 'DERIVED_FROM_RULES');
  assert.equal(classifyProviderDueBy(1_760_000_000), 'PROVIDER_SUPPLIED');
});

test('deadline: zero opens the case as unanswerable', () => {
  const decision = decide('D03');
  assert.equal(decision.basis, 'NO_RESPONSE_PERMITTED');
  assert.equal(decision.deadline, null);
  assert.equal(decision.internalTarget, null);
  assert.equal(statusAt(decision, at('2030-01-01T00:00:00Z')), 'NO_DEADLINE');
});

test('deadline: a zero sentinel read as a timestamp would look overdue by decades', () => {
  // This is the bug the sentinel check exists to prevent, stated as an
  // assertion rather than left as a comment.
  const wrong = 0 * 1000;
  assert.ok(wrong < at('2026-10-05T00:00:00Z'));
  assert.equal(render(wrong), '1970-01-01T00:00:00Z');
});

test('deadline: a negative due_by is refused rather than interpreted', () => {
  assert.throws(() => classifyProviderDueBy(-1), /negative/);
});

// ---------------------------------------------------------------------------
// Provider-supplied beats derived
// ---------------------------------------------------------------------------

test('deadline: a supplied deadline is taken as stated and no arithmetic runs', () => {
  const decision = decide('D01');
  assert.equal(decision.basis, 'PROVIDER_SUPPLIED');
  assert.equal(render(decision.deadline), '2026-10-26T03:59:59Z');
  assert.ok(!decision.trace.some((line) => line.includes('business days')));
});

test('deadline: a supplied deadline already in the past is recorded, not corrected', () => {
  const decision = decide('D10');
  assert.equal(decision.basis, 'PROVIDER_SUPPLIED');
  assert.equal(statusAt(decision, at('2026-10-28T09:00:00Z')), 'PAST_DEADLINE');
  assert.ok(minutesRemaining(decision, at('2026-10-28T09:00:00Z'))! < 0);
});

test('deadline: the trace names every input that produced the answer', () => {
  const decision = decide('D02');
  const joined = decision.trace.join('\n');
  assert.ok(joined.includes(decision.ruleVersion));
  assert.ok(joined.includes(decision.calendarVersion));
  assert.ok(joined.includes(decision.zoneTableVersion));
});

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

test('calendar: a five-day window skips the weekend and two holidays', () => {
  const walk = addBusinessDays(CALENDAR_NY_V1, { year: 2026, month: 11, day: 20, minutes: 0 }, 5);
  assert.equal(walk.endDate.month, 12);
  assert.equal(walk.endDate.day, 1);
  assert.ok(walk.steps.some((s) => s.includes('skipped (weekend)')));
  assert.ok(walk.steps.filter((s) => s.includes('skipped (holiday)')).length === 2);
});

test('calendar: the start date is never counted as a business day of the window', () => {
  const monday = { year: 2026, month: 11, day: 2, minutes: 0 };
  assert.ok(isBusinessDay(CALENDAR_NY_V1, monday));
  const walk = addBusinessDays(CALENDAR_NY_V1, monday, 1);
  assert.equal(walk.endDate.day, 3);
});

test('calendar: the weekend mask is data, so Saturday can be a working day', () => {
  const gulf = calendarByVersion('gulf-2026.1');
  const saturday = { year: 2026, month: 11, day: 7, minutes: 0 };
  const friday = { year: 2026, month: 11, day: 6, minutes: 0 };
  assert.equal(isBusinessDay(gulf, saturday), true);
  assert.equal(isBusinessDay(gulf, friday), false);
});

test('calendar: a window of zero business days ends on the start date', () => {
  const start = { year: 2026, month: 11, day: 20, minutes: 0 };
  assert.deepEqual(addBusinessDays(CALENDAR_NY_V1, start, 0).endDate, start);
});

test('calendar: a backwards window is refused', () => {
  assert.throws(() => addBusinessDays(CALENDAR_NY_V1, { year: 2026, month: 11, day: 20, minutes: 0 }, -1), /forwards/);
});

test('calendar: the cutoff conversion records how the civil time resolved', () => {
  const result = endOfWindow(ZONE_TABLE_CURRENT, CALENDAR_NY_V1, at('2026-10-23T13:00:00Z'), 5, 17 * 60);
  assert.ok(result.steps.some((s) => s.startsWith('civil-to-instant:')));
  assert.equal(result.ambiguity, 'UNIQUE');
});

// ---------------------------------------------------------------------------
// Daylight saving and zone-table versions
// ---------------------------------------------------------------------------

test('deadline: the same local cutoff moves by an hour across a daylight transition', () => {
  const before = decide('D04');
  const after = decide('D05');
  assert.equal(render(before.deadline), '2026-10-30T21:00:00Z');
  assert.equal(render(after.deadline), '2026-11-03T22:00:00Z');
  assert.equal((before.deadline! % 86_400_000) + 3_600_000, after.deadline! % 86_400_000);
});

test('deadline: one notification under two zone tables produces two deadlines', () => {
  const previous = decide('D06');
  const current = decide('D07');
  assert.equal(previous.ruleVersion, current.ruleVersion);
  assert.notEqual(previous.zoneTableVersion, current.zoneTableVersion);
  assert.equal(previous.deadline! - current.deadline!, 60 * 60_000);
});

test('deadline: a thirty-minute daylight shift is not rounded to an hour', () => {
  const decision = decide('D08');
  assert.equal(render(decision.deadline), '2026-10-07T06:00:00Z');
  // Standard offset would have put the same local cutoff half an hour later.
  assert.notEqual(render(decision.deadline), '2026-10-07T06:30:00Z');
});

// ---------------------------------------------------------------------------
// Rule versions
// ---------------------------------------------------------------------------

test('deadline: a later rule set produces a later deadline for the same notification', () => {
  const v1 = decide('D02');
  const v2 = decide('D11');
  assert.equal(v1.ruleVersion, 'disputes-2026.1');
  assert.equal(v2.ruleVersion, 'disputes-2026.2');
  assert.ok(v2.deadline! > v1.deadline!);
  assert.notEqual(v1.calendarVersion, v2.calendarVersion);
});

test('deadline: an unknown rule version is refused rather than defaulted', () => {
  assert.throws(() => ruleSetByVersion('disputes-1999.1'), /unknown rule version/);
  assert.throws(() => calendarByVersion('ny-1999.1'), /unknown calendar version/);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('deadline: DUE is the window between the internal target and the deadline', () => {
  const decision = computeDeadline({
    notification: notification({
      providerCaseId: 'dp-status',
      deliveryId: 'dl-1',
      raisedAt: '2026-10-05T00:00:00Z',
      dueBySeconds: seconds('2026-10-20T00:00:00Z'),
    }),
    rules: ruleSetByVersion('disputes-2026.1'),
    zoneTableVersion: 'synthetic-2026e',
  });
  assert.equal(statusAt(decision, at('2026-10-10T00:00:00Z')), 'COMFORTABLE');
  assert.equal(statusAt(decision, at('2026-10-19T12:00:00Z')), 'DUE');
  assert.equal(statusAt(decision, at('2026-10-20T00:00:00Z')), 'PAST_DEADLINE');
});

test('deadline: every fixture is reproducible from its recorded versions', () => {
  for (const fixture of DEADLINE_FIXTURES) {
    const first = computeDeadline({
      notification: fixture.notification,
      rules: ruleSetByVersion(fixture.ruleVersion),
      zoneTableVersion: fixture.zoneTableVersion,
    });
    const second = computeDeadline({
      notification: fixture.notification,
      rules: ruleSetByVersion(first.ruleVersion),
      zoneTableVersion: first.zoneTableVersion,
    });
    assert.equal(second.deadline, first.deadline, `${fixture.id} is not reproducible`);
  }
});
