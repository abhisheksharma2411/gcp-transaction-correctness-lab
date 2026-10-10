import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MAX_SCHEDULE_HORIZON_MS, onFire, scheduleNext, sweep } from '../src/timers.ts';
import type { DueRow, ScheduledTimer } from '../src/timers.ts';
import { at } from '../src/scenarios.ts';

const NOW = at('2026-10-07T00:00:00Z');

function row(overrides: Partial<DueRow> = {}): DueRow {
  return {
    caseId: 'c-1',
    internalTarget: at('2026-10-20T00:00:00Z'),
    deadline: at('2026-10-21T00:00:00Z'),
    terminal: false,
    answered: false,
    generation: 3,
    ...overrides,
  };
}

test('timers: a target inside thirty days is scheduled directly', () => {
  const result = scheduleNext(row(), NOW);
  assert.equal(result.hopsToTarget, 0);
  assert.equal(result.timer!.purpose, 'TARGET');
  assert.equal(result.timer!.fireAt, at('2026-10-20T00:00:00Z'));
});

test('timers: a target beyond thirty days needs renewal hops', () => {
  const far = row({ internalTarget: NOW + 71 * 86_400_000, deadline: NOW + 72 * 86_400_000 });
  const result = scheduleNext(far, NOW);
  assert.equal(result.hopsToTarget, 2);
  assert.equal(result.timer!.purpose, 'RENEWAL');
  assert.equal(result.timer!.fireAt, NOW + MAX_SCHEDULE_HORIZON_MS);
});

test('timers: the horizon is exactly thirty days', () => {
  assert.equal(MAX_SCHEDULE_HORIZON_MS, 30 * 24 * 60 * 60 * 1000);
  const exactly = row({ internalTarget: NOW + MAX_SCHEDULE_HORIZON_MS, deadline: NOW + MAX_SCHEDULE_HORIZON_MS + 1000 });
  assert.equal(scheduleNext(exactly, NOW).timer!.purpose, 'TARGET');
  const justOver = row({ internalTarget: NOW + MAX_SCHEDULE_HORIZON_MS + 1, deadline: NOW + MAX_SCHEDULE_HORIZON_MS + 1000 });
  assert.equal(scheduleNext(justOver, NOW).timer!.purpose, 'RENEWAL');
});

test('timers: a terminal or answered case gets no timer', () => {
  assert.equal(scheduleNext(row({ terminal: true }), NOW).timer, null);
  assert.equal(scheduleNext(row({ answered: true }), NOW).timer, null);
  assert.equal(scheduleNext(row({ internalTarget: null, deadline: null }), NOW).timer, null);
});

test('timers: a timer that fires twice produces the same verdict twice', () => {
  const current = row();
  const timer: ScheduledTimer = { caseId: 'c-1', generation: 3, fireAt: current.internalTarget!, purpose: 'TARGET' };
  const first = onFire(current, timer, at('2026-10-20T00:00:00Z'));
  const second = onFire(current, timer, at('2026-10-20T00:00:05Z'));
  assert.equal(first, 'ACT');
  assert.equal(second, 'ACT');
});

test('timers: a fire carrying a stale generation is dropped', () => {
  const current = row({ generation: 4 });
  const stale: ScheduledTimer = { caseId: 'c-1', generation: 3, fireAt: current.internalTarget!, purpose: 'TARGET' };
  assert.equal(onFire(current, stale, at('2026-10-20T00:00:00Z')), 'IGNORED_STALE_GENERATION');
});

test('timers: a fire against a terminal case is dropped', () => {
  const closed = row({ terminal: true });
  const timer: ScheduledTimer = { caseId: 'c-1', generation: 3, fireAt: closed.internalTarget!, purpose: 'TARGET' };
  assert.equal(onFire(closed, timer, at('2026-10-20T00:00:00Z')), 'IGNORED_TERMINAL');
});

test('timers: a fire that arrives early does nothing', () => {
  const current = row();
  const timer: ScheduledTimer = { caseId: 'c-1', generation: 3, fireAt: current.internalTarget!, purpose: 'TARGET' };
  assert.equal(onFire(current, timer, at('2026-10-19T00:00:00Z')), 'IGNORED_EARLY');
});

test('timers: a renewal fire asks for another timer rather than acting', () => {
  const far = row({ internalTarget: NOW + 71 * 86_400_000, deadline: NOW + 72 * 86_400_000 });
  const renewal = scheduleNext(far, NOW).timer!;
  assert.equal(onFire(far, renewal, renewal.fireAt), 'RENEW');
});

test('timers: a broken renewal chain is still caught by the sweep', () => {
  // No timer is ever created. The sweep reads the rows regardless.
  const far = row({ internalTarget: NOW + 40 * 86_400_000, deadline: NOW + 41 * 86_400_000 });
  const result = sweep([far], NOW + 40 * 86_400_000 + 1000);
  assert.deepEqual(result.due, ['c-1']);
});

test('timers: the sweep separates still-actionable from already-lost', () => {
  const rows: DueRow[] = [
    row({ caseId: 'due', internalTarget: at('2026-10-20T00:00:00Z'), deadline: at('2026-10-21T00:00:00Z') }),
    row({ caseId: 'lost', internalTarget: at('2026-10-01T00:00:00Z'), deadline: at('2026-10-02T00:00:00Z') }),
    row({ caseId: 'answered', answered: true }),
    row({ caseId: 'closed', terminal: true }),
    row({ caseId: 'undated', internalTarget: null, deadline: null }),
  ];
  const result = sweep(rows, at('2026-10-20T06:00:00Z'));
  assert.equal(result.scanned, 4);
  assert.equal(result.answered, 1);
  assert.deepEqual(result.due, ['due']);
  assert.deepEqual(result.pastDeadline, ['lost']);
  assert.deepEqual(result.noDeadline, ['undated']);
});

test('timers: the sweep reports its own scan count even when nothing is due', () => {
  const result = sweep([row()], at('2026-10-08T00:00:00Z'));
  assert.equal(result.scanned, 1);
  assert.equal(result.due.length, 0);
  assert.equal(result.pastDeadline.length, 0);
});

test('timers: the sweep output is sorted and therefore stable', () => {
  const rows = ['c', 'a', 'b'].map((id) => row({ caseId: id, internalTarget: at('2026-10-10T00:00:00Z'), deadline: at('2026-10-21T00:00:00Z') }));
  assert.deepEqual(sweep(rows, at('2026-10-11T00:00:00Z')).due, ['a', 'b', 'c']);
});
