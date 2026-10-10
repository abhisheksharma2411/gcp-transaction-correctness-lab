import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ZONE_TABLE_CURRENT,
  ZONE_TABLE_PREVIOUS,
  fromCivil,
  offsetAt,
  render,
  toCivil,
  zoneTableByVersion,
} from '../src/zones.ts';

const CURRENT = ZONE_TABLE_CURRENT;

test('zones: an overlapping civil time resolves to the earlier instant', () => {
  // 01:30 on 1 November 2026 happens twice in New York.
  const resolved = fromCivil(CURRENT, 'America/New_York', { year: 2026, month: 11, day: 1, minutes: 90 });
  assert.equal(resolved.ambiguity, 'OVERLAP');
  assert.equal(resolved.candidates.length, 2);
  assert.equal(resolved.instant, Math.min(...resolved.candidates));
  assert.equal(render(resolved.instant), '2026-11-01T05:30:00Z');
});

test('zones: a civil time inside a spring-forward gap resolves to the instant the gap opens', () => {
  const resolved = fromCivil(CURRENT, 'America/New_York', { year: 2026, month: 3, day: 8, minutes: 150 });
  assert.equal(resolved.ambiguity, 'GAP');
  assert.equal(resolved.candidates.length, 0);
  assert.equal(render(resolved.instant), '2026-03-08T07:00:00Z');
});

test('zones: an unambiguous civil time has exactly one candidate', () => {
  const resolved = fromCivil(CURRENT, 'America/New_York', { year: 2026, month: 6, day: 15, minutes: 17 * 60 });
  assert.equal(resolved.ambiguity, 'UNIQUE');
  assert.equal(resolved.candidates.length, 1);
});

test('zones: the same local cutoff is a different instant on either side of a transition', () => {
  const before = fromCivil(CURRENT, 'America/New_York', { year: 2026, month: 10, day: 30, minutes: 17 * 60 });
  const after = fromCivil(CURRENT, 'America/New_York', { year: 2026, month: 11, day: 3, minutes: 17 * 60 });
  assert.equal(render(before.instant), '2026-10-30T21:00:00Z');
  assert.equal(render(after.instant), '2026-11-03T22:00:00Z');
});

test('zones: Lord Howe Island shifts by thirty minutes, not sixty', () => {
  const standard = offsetAt(CURRENT, 'Australia/Lord_Howe', Date.parse('2026-09-01T00:00:00Z'));
  const daylight = offsetAt(CURRENT, 'Australia/Lord_Howe', Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(daylight - standard, 30);
});

test('zones: a zone with no transitions keeps one offset all year', () => {
  const january = offsetAt(CURRENT, 'Asia/Kolkata', Date.parse('2026-01-15T00:00:00Z'));
  const july = offsetAt(CURRENT, 'Asia/Kolkata', Date.parse('2026-07-15T00:00:00Z'));
  assert.equal(january, 330);
  assert.equal(july, 330);
});

test('zones: the two pinned tables disagree about Winnipeg after the rule change', () => {
  const instant = Date.parse('2026-11-04T18:00:00Z');
  assert.equal(offsetAt(ZONE_TABLE_PREVIOUS, 'America/Winnipeg', instant), -360);
  assert.equal(offsetAt(ZONE_TABLE_CURRENT, 'America/Winnipeg', instant), -300);
});

test('zones: the same civil cutoff produces different instants under the two tables', () => {
  const civil = { year: 2026, month: 11, day: 4, minutes: 17 * 60 };
  const previous = fromCivil(ZONE_TABLE_PREVIOUS, 'America/Winnipeg', civil);
  const current = fromCivil(ZONE_TABLE_CURRENT, 'America/Winnipeg', civil);
  assert.notEqual(previous.instant, current.instant);
  assert.equal(previous.instant - current.instant, 60 * 60_000);
});

test('zones: civil conversion round-trips for an unambiguous time', () => {
  const instant = Date.parse('2026-07-04T15:45:00Z');
  const civil = toCivil(CURRENT, 'America/New_York', instant);
  assert.equal(fromCivil(CURRENT, 'America/New_York', civil).instant, instant);
});

test('zones: an unknown zone or table version is refused rather than defaulted', () => {
  assert.throws(() => offsetAt(CURRENT, 'Mars/Olympus', 0), /not in table/);
  assert.throws(() => zoneTableByVersion('synthetic-1999a'), /unknown zone table/);
});

test('zones: the host time-zone database is never consulted', () => {
  // The table is the only source. If the host were being read, changing the
  // table would not change the answer.
  const civil = { year: 2026, month: 11, day: 4, minutes: 17 * 60 };
  const a = fromCivil(ZONE_TABLE_PREVIOUS, 'America/Winnipeg', civil).instant;
  const b = fromCivil(ZONE_TABLE_CURRENT, 'America/Winnipeg', civil).instant;
  assert.notEqual(a, b);
});
