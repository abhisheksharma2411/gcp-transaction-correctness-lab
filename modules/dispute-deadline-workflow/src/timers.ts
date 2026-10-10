// Durable timers, and why the timer is not the deadline.
//
// Cloud Tasks publishes two system limits that decide the shape of this file.
// "Maximum schedule time for a task" is "30 days from current date and time",
// described as "The maximum amount of time in the future that a task can be
// scheduled", and "Maximum task retention" is "31 days", "The time between
// when a task is added to a queue and when it is automatically deleted". The
// page says plainly that "System limits can't be changed."
//
// A dispute window longer than thirty days therefore cannot be expressed as
// one task. The obvious workaround -- schedule a renewal task that schedules
// the next one -- works, and it introduces a failure mode worse than the one
// it solves: a chain that breaks loses the deadline silently, because nothing
// in a queue reports a task that was never created.
//
// So the durable record is the row. The timer is a prompt, not a promise. A
// sweep over rows is what actually guarantees the deadline is noticed, and the
// timer only exists so that the sweep does not have to run every second.

import type { Instant } from './types.ts';

/** Cloud Tasks' published ceiling, as a constant so the arithmetic is visible. */
export const MAX_SCHEDULE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export interface DueRow {
  caseId: string;
  /** The instant the operations team must act by. */
  internalTarget: Instant | null;
  /** The real deadline, for escalation ordering. */
  deadline: Instant | null;
  terminal: boolean;
  /** Whether a submission the provider accepted is already on record. */
  answered: boolean;
  /** Incremented whenever the schedule is rewritten; stale fires are ignored. */
  generation: number;
}

export interface ScheduledTimer {
  caseId: string;
  generation: number;
  fireAt: Instant;
  /** `RENEWAL` means this fire exists only to schedule the next one. */
  purpose: 'RENEWAL' | 'TARGET';
}

export interface ScheduleResult {
  timer: ScheduledTimer | null;
  /** How many renewal hops stand between now and the target. */
  hopsToTarget: number;
  note: string;
}

/**
 * Pick the next timer for a case. When the target is beyond the platform's
 * horizon, schedule a renewal at the horizon instead and record how many hops
 * remain, because the hop count is the number of independent chances the chain
 * has to break.
 */
export function scheduleNext(row: DueRow, now: Instant): ScheduleResult {
  if (row.terminal || row.answered || row.internalTarget === null) {
    return { timer: null, hopsToTarget: 0, note: 'no timer: case is terminal, answered, or has no deadline' };
  }
  const distance = row.internalTarget - now;
  if (distance <= 0) {
    return {
      timer: { caseId: row.caseId, generation: row.generation, fireAt: now, purpose: 'TARGET' },
      hopsToTarget: 0,
      note: 'target already reached',
    };
  }
  const hops = Math.ceil(distance / MAX_SCHEDULE_HORIZON_MS) - 1;
  if (distance <= MAX_SCHEDULE_HORIZON_MS) {
    return {
      timer: {
        caseId: row.caseId,
        generation: row.generation,
        fireAt: row.internalTarget,
        purpose: 'TARGET',
      },
      hopsToTarget: 0,
      note: 'target is inside the schedule horizon',
    };
  }
  return {
    timer: {
      caseId: row.caseId,
      generation: row.generation,
      fireAt: now + MAX_SCHEDULE_HORIZON_MS,
      purpose: 'RENEWAL',
    },
    hopsToTarget: hops,
    note: `target is ${Math.floor(distance / 86_400_000)} days out; ${hops} renewal hop(s) needed`,
  };
}

export type FireVerdict = 'ACT' | 'RENEW' | 'IGNORED_STALE_GENERATION' | 'IGNORED_TERMINAL' | 'IGNORED_EARLY';

/**
 * Decide what a timer firing means. A timer that fires twice produces the same
 * verdict twice and the caller applies it idempotently; a timer carrying a
 * stale generation is dropped. Article 12 owns the general contract for
 * repeated arrivals, and this is one more boundary that obeys it.
 */
export function onFire(row: DueRow, timer: ScheduledTimer, now: Instant): FireVerdict {
  if (timer.generation !== row.generation) return 'IGNORED_STALE_GENERATION';
  if (row.terminal || row.answered) return 'IGNORED_TERMINAL';
  if (row.internalTarget === null) return 'IGNORED_TERMINAL';
  if (timer.purpose === 'RENEWAL') return 'RENEW';
  if (now < row.internalTarget) return 'IGNORED_EARLY';
  return 'ACT';
}

/**
 * The sweep. Everything above is an optimisation; this is the part that cannot
 * silently stop working, because it reads the same rows that hold the truth
 * and it reports what it found even when it found nothing to do.
 */
export interface SweepResult {
  /** Non-terminal rows considered. */
  scanned: number;
  /** Of those, the ones that already carry an accepted submission. */
  answered: number;
  /** Past the internal target, deadline not yet reached: still actionable. */
  due: string[];
  /** Past the deadline with nothing submitted: the loss has already happened. */
  pastDeadline: string[];
  /** Open, but with no deadline to measure against. */
  noDeadline: string[];
}

export function sweep(rows: DueRow[], now: Instant): SweepResult {
  const result: SweepResult = { scanned: 0, answered: 0, due: [], pastDeadline: [], noDeadline: [] };
  for (const row of rows) {
    if (row.terminal) continue;
    result.scanned += 1;
    if (row.answered) {
      result.answered += 1;
      continue;
    }
    if (row.internalTarget === null || row.deadline === null) {
      result.noDeadline.push(row.caseId);
      continue;
    }
    if (now >= row.deadline) result.pastDeadline.push(row.caseId);
    else if (now >= row.internalTarget) result.due.push(row.caseId);
  }
  result.due.sort();
  result.pastDeadline.sort();
  result.noDeadline.sort();
  return result;
}
