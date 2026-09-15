import type { Percentiles } from "./types.ts";

/**
 * Nearest-rank percentiles over an unsorted sample.
 *
 * Deliberately exact rather than an approximate sketch: these runs hold tens of
 * thousands of samples, not billions, and an exact number removes one class of
 * argument about whether a reported p99 is real.
 */
export function percentiles(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => {
    const rank = Math.ceil(q * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
  };
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1]!),
  };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
