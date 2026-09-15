import type { AdmissionPolicy, SimConfig, WorkerPolicy, TenantId } from "./types.ts";

/**
 * One place for every number the experiments use, so the article can quote the
 * capacity arithmetic and a reader can check it.
 *
 * Bounded concurrency 20, mean service demand 100 ms, so the sustainable
 * completion rate is 20 / 0.1 s = 200 jobs per second. Every scenario below is
 * expressed as a multiple of that 200/s figure.
 */
export const CONCURRENCY = 20;
export const MEAN_SERVICE_MS = 100;
export const SUSTAINABLE_RATE_PER_SEC = (CONCURRENCY / MEAN_SERVICE_MS) * 1000; // 200

export const BASE_WORKER: WorkerPolicy = {
  concurrency: CONCURRENCY,
  // Zero by default: the headline comparison must not depend on a modelled
  // degradation curve. Only the envelope sweep turns this on.
  contentionPerUnit: 0,
  contentionKnee: CONCURRENCY,
};

/**
 * The depth limit is a backstop and must sit ABOVE the depth the promise rule
 * implies, or it fires first and the promise rule becomes unreachable.
 *
 * At the sustainable rate of 200/s a 2000 ms promise is breached at roughly
 * 400 queued jobs, so a 200-deep limit would mean the promise check never ran.
 * The first version of this policy had exactly that defect and test T5 found
 * it. The backstop is set to 600: high enough that the promise governs normal
 * shedding, low enough to bound memory if the drain estimate is ever wrong.
 */
export const PROMISE_MS = 2000;
export const IMPLIED_DEPTH_AT_PROMISE = (SUSTAINABLE_RATE_PER_SEC * PROMISE_MS) / 1000; // 400

export const BASE_ADMISSION: AdmissionPolicy = {
  maxQueueDepth: 600,
  promiseMs: PROMISE_MS,
  maxQueueAgeMs: 1500,
  maxTenantShare: 0.6,
  maxReservations: 2000,
  fairShareProjection: true,
};

export function config(overrides: Partial<SimConfig> & { arrivalRatePerSec: ReadonlyMap<TenantId, number> }): SimConfig {
  return {
    seed: 1234,
    durationMs: 60_000,
    meanServiceMs: MEAN_SERVICE_MS,
    worker: BASE_WORKER,
    abandonAfterMs: 8000,
    reservationTtlMs: 30_000,
    ...overrides,
  };
}

/** Single tenant at a multiple of sustainable rate. */
export function load(multiple: number, tenant: TenantId = "acme"): ReadonlyMap<TenantId, number> {
  return new Map([[tenant, SUSTAINABLE_RATE_PER_SEC * multiple]]);
}
