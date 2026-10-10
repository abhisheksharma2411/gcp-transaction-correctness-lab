// Business calendars as versioned data.
//
// A contractual window written in business days needs three things the clock
// does not supply: which days are weekends, which days are holidays, and which
// wall clock decides when a day ends. All three are inputs here, each carried
// with a version, because all three differ by counterparty and all three
// change.

import type { BusinessCalendar, Instant, ZoneTable } from './types.ts';
import { addDays, dayOfWeek, fromCivil, isoDate, toCivil } from './zones.ts';
import type { Civil } from './zones.ts';

export const CALENDAR_NY_V1: BusinessCalendar = {
  version: 'ny-2026.1',
  calendarId: 'operations-new-york',
  zone: 'America/New_York',
  weekend: [0, 6],
  holidays: ['2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01'],
};

/**
 * The same calendar after the operations team adds a shutdown day. Used to
 * show that a calendar revision does not rewrite a deadline already fixed.
 */
export const CALENDAR_NY_V2: BusinessCalendar = {
  version: 'ny-2026.2',
  calendarId: 'operations-new-york',
  zone: 'America/New_York',
  weekend: [0, 6],
  holidays: ['2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2027-01-01'],
};

/** A six-day week with a Friday weekend, to keep the weekend mask honest. */
export const CALENDAR_GULF_V1: BusinessCalendar = {
  version: 'gulf-2026.1',
  calendarId: 'operations-gulf',
  zone: 'Asia/Kolkata',
  weekend: [5],
  holidays: [],
};

/** Winnipeg, the zone whose rules changed between the two pinned tables. */
export const CALENDAR_WPG_V1: BusinessCalendar = {
  version: 'wpg-2026.1',
  calendarId: 'operations-winnipeg',
  zone: 'America/Winnipeg',
  weekend: [0, 6],
  holidays: [],
};

/** Lord Howe Island, whose daylight shift is thirty minutes rather than sixty. */
export const CALENDAR_LHI_V1: BusinessCalendar = {
  version: 'lhi-2026.1',
  calendarId: 'operations-lord-howe',
  zone: 'Australia/Lord_Howe',
  weekend: [0, 6],
  holidays: [],
};

export const CALENDARS: BusinessCalendar[] = [
  CALENDAR_NY_V1,
  CALENDAR_NY_V2,
  CALENDAR_GULF_V1,
  CALENDAR_WPG_V1,
  CALENDAR_LHI_V1,
];

export function calendarByVersion(version: string): BusinessCalendar {
  const found = CALENDARS.find((c) => c.version === version);
  if (!found) throw new Error(`unknown calendar version: ${version}`);
  return found;
}

export function isBusinessDay(calendar: BusinessCalendar, civil: Civil): boolean {
  if (calendar.weekend.includes(dayOfWeek(civil))) return false;
  return !calendar.holidays.includes(isoDate(civil));
}

export interface BusinessDayWalk {
  /** The local date the window lands on. */
  endDate: Civil;
  /** Each date considered, with why it counted or did not. */
  steps: string[];
}

/**
 * Walk forward `count` business days from a local date. Day zero is the start
 * date and is never counted, whether or not it is a business day: a window of
 * "five business days from notification" ends five working days later, and
 * reading it otherwise silently shortens or lengthens every case opened on a
 * Saturday.
 */
export function addBusinessDays(
  calendar: BusinessCalendar,
  start: Civil,
  count: number,
): BusinessDayWalk {
  if (count < 0) throw new Error('business-day windows run forwards');
  const steps: string[] = [`start ${isoDate(start)}`];
  let cursor = start;
  let remaining = count;
  let guard = 0;
  while (remaining > 0) {
    if (guard++ > 400) throw new Error('business-day walk did not terminate within 400 days');
    cursor = addDays(cursor, 1);
    if (isBusinessDay(calendar, cursor)) {
      remaining -= 1;
      steps.push(`${isoDate(cursor)} counted (${count - remaining}/${count})`);
    } else {
      const why = calendar.weekend.includes(dayOfWeek(cursor)) ? 'weekend' : 'holiday';
      steps.push(`${isoDate(cursor)} skipped (${why})`);
    }
  }
  return { endDate: cursor, steps };
}

export interface CutoffResult {
  instant: Instant;
  ambiguity: string;
  steps: string[];
}

/**
 * Place the end of a business-day window at the calendar's local cutoff and
 * convert it back to an instant, recording how the conversion resolved.
 */
export function endOfWindow(
  table: ZoneTable,
  calendar: BusinessCalendar,
  start: Instant,
  businessDays: number,
  cutoffLocalMinutes: number,
): CutoffResult {
  const startCivil = toCivil(table, calendar.zone, start);
  const walk = addBusinessDays(calendar, startCivil, businessDays);
  const target: Civil = { ...walk.endDate, minutes: cutoffLocalMinutes };
  const resolved = fromCivil(table, calendar.zone, target);
  const hh = String(Math.floor(cutoffLocalMinutes / 60)).padStart(2, '0');
  const mm = String(cutoffLocalMinutes % 60).padStart(2, '0');
  return {
    instant: resolved.instant,
    ambiguity: resolved.ambiguity,
    steps: [
      ...walk.steps,
      `cutoff ${isoDate(target)} ${hh}:${mm} local (${calendar.zone}, table ${table.version})`,
      `civil-to-instant: ${resolved.ambiguity} -- ${resolved.note}`,
    ],
  };
}
