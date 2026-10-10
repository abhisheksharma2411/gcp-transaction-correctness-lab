// Time-zone rules as pinned data.
//
// The host operating system has a time-zone database. This module deliberately
// does not use it. Zone rules change several times a year by political
// decision, and a deadline computed last month under one rule set is not
// reproducible next month under another unless the rule set is recorded with
// the result. Treating the rules as an ambient fact of the machine makes the
// most important property of a deadline engine -- that you can re-derive any
// past deadline exactly -- depend on when you happen to run it.
//
// So the transitions below are data, carried with a version, and every
// deadline records which version produced it. `scripts/tz-drift.ts` compares
// this table against whatever the host believes; it is a report, not a gate,
// because a gate here would make `make verify` fail on a machine that is
// merely more up to date.
//
// The tables are SYNTHETIC. They model a handful of zones over a bounded
// window for the cases this module needs to exercise. See docs/MODEL.md.

import type { Instant, ZoneId, ZoneTable, ZoneTransition } from './types.ts';

function at(iso: string): Instant {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`zone table: unparseable instant ${iso}`);
  return ms;
}

function t(iso: string, offsetMinutes: number, abbreviation: string): ZoneTransition {
  return { from: at(iso), offsetMinutes, abbreviation };
}

const UTC_ONLY: ZoneTransition[] = [t('1970-01-01T00:00:00Z', 0, 'UTC')];

/** +05:30 all year. A half-hour offset that never moves. */
const KOLKATA: ZoneTransition[] = [t('1970-01-01T00:00:00Z', 330, 'IST')];

/** Northern-hemisphere daylight saving, one hour. */
const NEW_YORK: ZoneTransition[] = [
  t('1970-01-01T00:00:00Z', -300, 'EST'),
  t('2026-03-08T07:00:00Z', -240, 'EDT'),
  t('2026-11-01T06:00:00Z', -300, 'EST'),
  t('2027-03-14T07:00:00Z', -240, 'EDT'),
];

const LONDON: ZoneTransition[] = [
  t('1970-01-01T00:00:00Z', 0, 'GMT'),
  t('2026-03-29T01:00:00Z', 60, 'BST'),
  t('2026-10-25T01:00:00Z', 0, 'GMT'),
  t('2027-03-28T01:00:00Z', 60, 'BST'),
];

/**
 * Southern-hemisphere daylight saving of THIRTY minutes. Any arithmetic that
 * assumes a daylight shift is a whole hour is wrong here, and wrong quietly.
 */
const LORD_HOWE: ZoneTransition[] = [
  t('1970-01-01T00:00:00Z', 630, '+1030'),
  t('2026-10-03T15:30:00Z', 660, '+11'),
  t('2027-04-03T15:00:00Z', 630, '+1030'),
];

/**
 * Winnipeg under the older rule: daylight saving ends and the zone returns to
 * -06:00 on 2026-11-01.
 */
const WINNIPEG_OLD: ZoneTransition[] = [
  t('1970-01-01T00:00:00Z', -360, 'CST'),
  t('2026-03-08T08:00:00Z', -300, 'CDT'),
  t('2026-11-01T07:00:00Z', -360, 'CST'),
];

/**
 * Winnipeg under the newer rule: the zone stays at -05:00 from 2026-10-31 and
 * does not return. Modelled on the change recorded in IANA Time Zone Database
 * release 2026e (released 2026-09-29): "Manitoba moves to permanent -05 on
 * 2026-10-31." The transition instant below is this module's own reading of
 * that sentence, not a copy of the database.
 */
const WINNIPEG_NEW: ZoneTransition[] = [
  t('1970-01-01T00:00:00Z', -360, 'CST'),
  t('2026-03-08T08:00:00Z', -300, 'CDT'),
  t('2026-10-31T00:00:00Z', -300, '-05'),
];

const COMMON: Record<ZoneId, ZoneTransition[]> = {
  UTC: UTC_ONLY,
  'Asia/Kolkata': KOLKATA,
  'America/New_York': NEW_YORK,
  'Europe/London': LONDON,
  'Australia/Lord_Howe': LORD_HOWE,
};

/** The table in force before the Manitoba change. */
export const ZONE_TABLE_PREVIOUS: ZoneTable = {
  version: 'synthetic-2026d',
  zones: { ...COMMON, 'America/Winnipeg': WINNIPEG_OLD },
};

/** The table in force after it. */
export const ZONE_TABLE_CURRENT: ZoneTable = {
  version: 'synthetic-2026e',
  zones: { ...COMMON, 'America/Winnipeg': WINNIPEG_NEW },
};

/**
 * The window these synthetic tables actually model.
 *
 * Outside it the tables fall back to whichever transition came last, which is
 * right for arithmetic and wrong as a description of the world. Every fixture
 * in this module sits inside the window, and `scripts/tz-drift.ts` only probes
 * inside it, because comparing a deliberately bounded table against a complete
 * one outside its bounds measures nothing.
 */
export const MODELLED_WINDOW = {
  from: Date.parse('2026-09-01T00:00:00Z'),
  to: Date.parse('2027-03-01T00:00:00Z'),
};

export function zoneTableByVersion(version: string): ZoneTable {
  if (version === ZONE_TABLE_PREVIOUS.version) return ZONE_TABLE_PREVIOUS;
  if (version === ZONE_TABLE_CURRENT.version) return ZONE_TABLE_CURRENT;
  throw new Error(`unknown zone table version: ${version}`);
}

export function offsetAt(table: ZoneTable, zone: ZoneId, instant: Instant): number {
  const transitions = table.zones[zone];
  if (!transitions) throw new Error(`zone ${zone} is not in table ${table.version}`);
  let offset = transitions[0]!.offsetMinutes;
  for (const transition of transitions) {
    if (transition.from <= instant) offset = transition.offsetMinutes;
    else break;
  }
  return offset;
}

// ---------------------------------------------------------------------------
// Civil time
// ---------------------------------------------------------------------------

export interface Civil {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  minutes: number; // minutes past local midnight
}

/**
 * Convert an instant to local civil time. `Date` is used only through its UTC
 * accessors, so the host's own zone never enters the calculation.
 */
export function toCivil(table: ZoneTable, zone: ZoneId, instant: Instant): Civil {
  const shifted = new Date(instant + offsetAt(table, zone, instant) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

export type Ambiguity = 'UNIQUE' | 'GAP' | 'OVERLAP';

export interface Resolution {
  instant: Instant;
  ambiguity: Ambiguity;
  /** Every instant that the civil time could denote, ascending. */
  candidates: Instant[];
  note: string;
}

/**
 * Convert a local civil time back to an instant.
 *
 * A civil time is not always one instant. On the morning a zone springs
 * forward it can be no instant at all, and on the morning it falls back it can
 * be two. The resolution policy here is deliberate and uniform:
 *
 *   **always take the earliest candidate.**
 *
 * For a deadline that is the conservative direction. On an overlap, the
 * earlier of the two instants arrives sooner, so the system treats the case as
 * due sooner. In a gap, the civil time the contract names does not exist, and
 * the earliest instant that could reasonably stand for it is the last moment
 * before the clocks jumped -- again sooner. A system that resolved in the
 * other direction would quietly award itself extra time on exactly two
 * mornings a year, which is the kind of bug that only ever shows up in the
 * cases you lose.
 */
export function fromCivil(table: ZoneTable, zone: ZoneId, civil: Civil): Resolution {
  const naive = Date.UTC(civil.year, civil.month - 1, civil.day, 0, 0, 0, 0) + civil.minutes * 60_000;
  const transitions = table.zones[zone];
  if (!transitions) throw new Error(`zone ${zone} is not in table ${table.version}`);

  const offsets = new Set<number>(transitions.map((x) => x.offsetMinutes));
  const candidates: Instant[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset * 60_000;
    // A candidate is real only if the zone really is at that offset then.
    if (offsetAt(table, zone, candidate) === offset) candidates.push(candidate);
  }
  candidates.sort((a, b) => a - b);

  if (candidates.length === 1) {
    return { instant: candidates[0]!, ambiguity: 'UNIQUE', candidates, note: 'one instant' };
  }
  if (candidates.length > 1) {
    return {
      instant: candidates[0]!,
      ambiguity: 'OVERLAP',
      candidates,
      note: `civil time occurs ${candidates.length} times; took the earliest`,
    };
  }

  // No candidate: the civil time falls in a gap. Take the instant at which the
  // gap opens, which is the last instant before the forward jump.
  // `naive` is local time expressed as if it were UTC, so a forward jump of
  // `after - before` minutes removes exactly that span of local time starting
  // at the transition instant.
  const transition = transitions.find((x) => {
    const before = offsetAt(table, zone, x.from - 1);
    const after = x.offsetMinutes;
    if (after <= before) return false;
    return naive >= x.from + before * 60_000 && naive < x.from + after * 60_000;
  });
  if (!transition) {
    throw new Error(`civil time ${civil.year}-${civil.month}-${civil.day} +${civil.minutes}m is unresolvable in ${zone}`);
  }
  return {
    instant: transition.from,
    ambiguity: 'GAP',
    candidates: [],
    note: 'civil time does not exist; took the instant the gap opens',
  };
}

export function dayOfWeek(civil: Civil): number {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
}

export function isoDate(civil: Civil): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}`;
}

export function addDays(civil: Civil, days: number): Civil {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    minutes: civil.minutes,
  };
}

/** Render an instant as a stable UTC string for reports and audit entries. */
export function render(instant: Instant | null): string {
  if (instant === null) return '(none)';
  return new Date(instant).toISOString().replace('.000Z', 'Z');
}
