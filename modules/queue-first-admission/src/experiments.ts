import { simulate } from "./simulator.ts";
import {
  BASE_ADMISSION,
  BASE_WORKER,
  CONCURRENCY,
  MEAN_SERVICE_MS,
  SUSTAINABLE_RATE_PER_SEC,
  config,
  load,
} from "./scenarios.ts";
import type { SimResult, TenantId } from "./types.ts";

export interface Experiment {
  readonly id: string;
  readonly question: string;
  readonly run: () => { open: SimResult; bounded: SimResult };
}

const pair = (label: string, overrides: Parameters<typeof config>[0]) => ({
  open: simulate(`${label} / open-loop`, config({ ...overrides, admission: undefined })),
  bounded: simulate(`${label} / bounded`, config({ ...overrides, admission: BASE_ADMISSION })),
});

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: "E1-baseline",
    question: "Below capacity, does admission control cost anything?",
    run: () => pair("E1 0.6x", { arrivalRatePerSec: load(0.6) }),
  },
  {
    id: "E2-burst",
    question: "A short burst to 4x. Does the system recover, and what did callers see?",
    run: () =>
      pair("E2 burst 4x", {
        arrivalRatePerSec: load(0.6),
        phases: [
          { fromMs: 0, toMs: 20_000, ratePerSec: load(0.6) },
          { fromMs: 20_000, toMs: 30_000, ratePerSec: load(4) },
          { fromMs: 30_000, toMs: 60_000, ratePerSec: load(0.6) },
        ],
      }),
  },
  {
    id: "E3-sustained-overload",
    question: "Sustained 2x. What happens to p99 and to callers who gave up?",
    run: () => pair("E3 2x sustained", { arrivalRatePerSec: load(2) }),
  },
  {
    id: "E4-worker-slowdown",
    question: "The dependency slows 3x mid-run at constant load. Does admission adapt?",
    run: () =>
      pair("E4 slowdown 3x", {
        arrivalRatePerSec: load(0.8),
        slowdownFromMs: 25_000,
        slowdownFactor: 3,
      }),
  },
  {
    id: "E5-connection-limit",
    question: "Halve the worker slots, as a connection or session pool would. Same offered load.",
    run: () =>
      pair("E5 slots 20->10", {
        arrivalRatePerSec: load(0.8),
        worker: { ...BASE_WORKER, concurrency: CONCURRENCY / 2 },
      }),
  },
  {
    id: "E6-queue-age",
    question:
      "Under a 5x dependency slowdown with a deep depth limit and no promise " +
      "check, does the age rule shed load that depth alone would have accepted?",
    // Depth and promise are both disabled so the age rule is the only variable.
    // Without this isolation the promise check fires first and the age rule
    // never runs, which is what the first version of this experiment showed:
    // two identical rows proving nothing.
    run: () => {
      const depthOnly = {
        ...BASE_ADMISSION,
        maxQueueDepth: 5000,
        promiseMs: Number.POSITIVE_INFINITY,
        maxQueueAgeMs: Number.POSITIVE_INFINITY,
      };
      const withAge = { ...depthOnly, maxQueueAgeMs: 1500 };
      const base = {
        arrivalRatePerSec: load(0.9),
        slowdownFromMs: 20_000,
        slowdownFactor: 5,
      } as const;
      return {
        open: simulate("E6 depth only / open-loop", config({ ...base, admission: depthOnly })),
        bounded: simulate("E6 age rule / bounded", config({ ...base, admission: withAge })),
      };
    },
  },
  {
    id: "E7-fairness",
    question: "One tenant floods at 3x while a neighbour sends 0.3x. Is the neighbour protected?",
    run: () => {
      const mixed: ReadonlyMap<TenantId, number> = new Map([
        ["flooder", SUSTAINABLE_RATE_PER_SEC * 3],
        ["neighbour", SUSTAINABLE_RATE_PER_SEC * 0.3],
      ]);
      return pair("E7 noisy neighbour", { arrivalRatePerSec: mixed });
    },
  },
  {
    id: "E8-recovery",
    question: "After overload ends, how long until callers see normal latency again?",
    run: () =>
      pair("E8 recovery", {
        arrivalRatePerSec: load(0.5),
        phases: [
          { fromMs: 0, toMs: 30_000, ratePerSec: load(3) },
          { fromMs: 30_000, toMs: 60_000, ratePerSec: load(0.5) },
        ],
      }),
  },
  {
    id: "E9-deferrable",
    question: "When work may be deferred, does a reservation beat a refusal?",
    run: () => {
      const async: ReadonlyMap<TenantId, number> = new Map([
        ["bulk-async", SUSTAINABLE_RATE_PER_SEC * 2],
      ]);
      return pair("E9 deferrable 2x", { arrivalRatePerSec: async });
    },
  },
];

/**
 * The overload envelope.
 *
 * Sweeps offered load against worker slots with the contention model switched
 * ON, to locate the point at which adding capacity stops helping. The
 * contention coefficient is an assumption, not a measurement; see ADR-002.
 * What the sweep demonstrates is that a knee exists and where it sits for a
 * given coefficient, not that Spanner or Cloud Run has this exact curve.
 */
export interface EnvelopePoint {
  readonly slots: number;
  readonly offeredMultiple: number;
  readonly goodputPerSec: number;
  readonly p99Ms: number;
}

export function envelope(contentionPerUnit: number): EnvelopePoint[] {
  const points: EnvelopePoint[] = [];
  for (const slots of [10, 20, 40, 80, 160]) {
    const r = simulate(`env slots=${slots}`, config({
      arrivalRatePerSec: load(3),
      worker: { concurrency: slots, contentionPerUnit, contentionKnee: 20 },
      admission: BASE_ADMISSION,
    }));
    points.push({
      slots,
      offeredMultiple: 3,
      goodputPerSec: r.goodputPerSec,
      p99Ms: r.latency.p99,
    });
  }
  return points;
}

export const CAPACITY_NOTE =
  `concurrency=${CONCURRENCY}, meanService=${MEAN_SERVICE_MS}ms, ` +
  `sustainable=${SUSTAINABLE_RATE_PER_SEC}/s`;
