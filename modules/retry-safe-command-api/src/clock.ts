/** A clock the tests can move deliberately. Wall-clock time makes retention
 *  and lease behaviour untestable, and untestable retention is how expired
 *  idempotency keys turn into second charges. */
export interface Clock {
  nowMs(): number;
  advance(ms: number): void;
}

export function deterministicClock(startMs = 1_760_000_000_000): Clock {
  let t = startMs;
  return {
    nowMs: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
