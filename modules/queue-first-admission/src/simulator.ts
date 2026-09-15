import { decide, isDeferrable, type QueueView } from "./admission.ts";
import { MinHeap } from "./heap.ts";
import { percentiles, round } from "./metrics.ts";
import { Rng } from "./rng.ts";
import type { Job, SimConfig, SimResult, TenantId } from "./types.ts";

type EventKind = "ARRIVAL" | "COMPLETION" | "PATIENCE_EXPIRY" | "RESERVATION_EXPIRY";

interface Event {
  readonly at: number;
  readonly kind: EventKind;
  readonly job: Job;
  /** Tie-break so equal timestamps resolve deterministically. */
  readonly seq: number;
}

/**
 * Discrete-event simulation of one protected work path.
 *
 * Virtual time only. No sleeping, no wall clock, no network. The same seed
 * produces the same numbers on any machine, which is the only reason the
 * figures in the article are quotable.
 */
export function simulate(label: string, config: SimConfig): SimResult {
  const rng = new Rng(config.seed);
  const events = new MinHeap<Event>((a, b) => (a.at === b.at ? a.seq < b.seq : a.at < b.at));
  let seq = 0;
  const push = (at: number, kind: EventKind, job: Job): void => {
    events.push({ at, kind, job, seq: seq++ });
  };

  // --- Arrivals are generated up front, so the offered load is identical
  // --- across modes. Comparing bounded and open-loop against different
  // --- arrival streams would prove nothing.
  let nextId = 0;
  const arrivals: Job[] = [];
  const phases = config.phases ?? [
    { fromMs: 0, toMs: config.durationMs, ratePerSec: config.arrivalRatePerSec },
  ];
  for (const phase of phases) {
    for (const [tenant, ratePerSec] of phase.ratePerSec) {
      const ratePerMs = ratePerSec / 1000;
      let t = phase.fromMs;
      for (;;) {
        t += rng.exponential(ratePerMs);
        if (t >= phase.toMs || t >= config.durationMs) break;
        arrivals.push({
          id: nextId++,
          tenant,
          arrivedAt: t,
          // Exponential service demand: most checkouts are quick, a few are not.
          serviceMs: rng.exponential(1 / config.meanServiceMs),
        });
      }
    }
  }
  arrivals.sort((a, b) => (a.arrivedAt === b.arrivedAt ? a.id - b.id : a.arrivedAt - b.arrivedAt));
  for (const job of arrivals) push(job.arrivedAt, "ARRIVAL", job);

  // --- Mutable run state ---
  const waiting: Job[] = [];
  const perTenantDepth = new Map<TenantId, number>();
  let running = 0;
  let outstandingReservations = 0;
  let completedCount = 0;
  // Completions that landed inside the arrival window. Goodput must be
  // measured over the window, not over the window plus however long the
  // backlog took to drain afterwards -- otherwise an overloaded run reports a
  // throughput above its own service capacity, which is arithmetically
  // impossible and was in fact the first bug this harness caught.
  let completedInWindow = 0;
  let unfinishedAtHorizon = 0;

  const latencies: number[] = [];
  const counts = { admitted: 0, rejected: 0, deferred: 0, expired: 0, abandoned: 0 };
  const rejectReasons: Record<string, number> = {};
  const perTenant: Record<string, { admitted: number; rejected: number; completed: number }> = {};
  let maxQueueDepth = 0;
  let maxQueueAgeMs = 0;
  let peakConcurrency = 0;

  const tenantBucket = (t: TenantId) =>
    (perTenant[t] ??= { admitted: 0, rejected: 0, completed: 0 });

  // Observed mean service time, seeded with the configured mean as a prior and
  // corrected by every completion. This is what makes admission adaptive: a
  // slower database raises this number, which lowers the drain estimate, which
  // tightens admission before the queue has visibly grown.
  let serviceSamples = 0;
  let serviceMeanMs = config.meanServiceMs;

  const view = (now: number): QueueView => ({
    depth: waiting.length,
    oldestAgeMs: waiting.length > 0 ? now - waiting[0]!.arrivedAt : 0,
    perTenantDepth,
    drainRatePerSec: serviceMeanMs > 0 ? (config.worker.concurrency / serviceMeanMs) * 1000 : 0,
    freeSlots: Math.max(0, config.worker.concurrency - running),
    outstandingReservations,
  });

  const enqueue = (job: Job): void => {
    waiting.push(job);
    perTenantDepth.set(job.tenant, (perTenantDepth.get(job.tenant) ?? 0) + 1);
    maxQueueDepth = Math.max(maxQueueDepth, waiting.length);
  };

  const removeFromQueue = (job: Job): boolean => {
    const i = waiting.indexOf(job);
    if (i < 0) return false;
    waiting.splice(i, 1);
    perTenantDepth.set(job.tenant, (perTenantDepth.get(job.tenant) ?? 1) - 1);
    return true;
  };

  const dispatch = (now: number): void => {
    while (running < config.worker.concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      perTenantDepth.set(job.tenant, (perTenantDepth.get(job.tenant) ?? 1) - 1);
      running += 1;
      peakConcurrency = Math.max(peakConcurrency, running);
      maxQueueAgeMs = Math.max(maxQueueAgeMs, now - job.arrivedAt);
      job.waitedMs = now - job.arrivedAt;

      // Contention penalty. A MODEL PARAMETER, not a measurement of any
      // Google Cloud product. See docs/adr/ADR-002.
      const over = Math.max(0, running - config.worker.contentionKnee);
      const slowdown =
        config.slowdownFromMs !== undefined && now >= config.slowdownFromMs
          ? (config.slowdownFactor ?? 1)
          : 1;
      const effective =
        job.serviceMs * slowdown * (1 + config.worker.contentionPerUnit * over);
      push(now + effective, "COMPLETION", job);
    }
  };

  // --- Event loop ---
  while (events.size > 0) {
    const ev = events.pop()!;
    const now = ev.at;
    const job = ev.job;

    switch (ev.kind) {
      case "ARRIVAL": {
        const bucket = tenantBucket(job.tenant);
        if (!config.admission) {
          // Open loop: everything is accepted. This is the mode most systems
          // are in without having chosen it.
          counts.admitted += 1;
          bucket.admitted += 1;
          job.disposition = "ADMITTED";
          enqueue(job);
          push(now + config.abandonAfterMs, "PATIENCE_EXPIRY", job);
        } else {
          const d = decide(config.admission, view(now), job.tenant, isDeferrable(job));
          if (d.disposition === "REJECTED") {
            counts.rejected += 1;
            bucket.rejected += 1;
            job.disposition = "REJECTED";
            job.rejectReason = d.reason;
            job.finishedAt = now;
            rejectReasons[d.reason] = (rejectReasons[d.reason] ?? 0) + 1;
          } else if (d.disposition === "DEFERRED") {
            counts.deferred += 1;
            outstandingReservations += 1;
            job.disposition = "DEFERRED";
            job.rejectReason = d.reason;
            enqueue(job);
            push(now + config.reservationTtlMs, "RESERVATION_EXPIRY", job);
          } else {
            counts.admitted += 1;
            bucket.admitted += 1;
            job.disposition = "ADMITTED";
            enqueue(job);
            push(now + config.abandonAfterMs, "PATIENCE_EXPIRY", job);
          }
        }
        dispatch(now);
        break;
      }

      case "COMPLETION": {
        running -= 1;
        if (job.disposition === "DEFERRED") outstandingReservations -= 1;
        completedCount += 1;
        // Update the observed service mean from what this job actually cost.
        const observed = now - (job.arrivedAt + (job.waitedMs ?? 0));
        serviceSamples += 1;
        serviceMeanMs += (observed - serviceMeanMs) / Math.min(serviceSamples, 200);
        job.finishedAt = now;
        latencies.push(now - job.arrivedAt);
        if (now <= config.durationMs) completedInWindow += 1;
        tenantBucket(job.tenant).completed += 1;
        dispatch(now);
        break;
      }

      case "PATIENCE_EXPIRY": {
        // A caller who is still waiting when patience runs out is gone. The
        // work they queued is wasted capacity: the classic overload spiral.
        if (job.finishedAt === undefined && removeFromQueue(job)) {
          job.disposition = "ABANDONED";
          job.finishedAt = now;
          counts.abandoned += 1;
        }
        break;
      }

      case "RESERVATION_EXPIRY": {
        if (job.finishedAt === undefined && removeFromQueue(job)) {
          job.disposition = "EXPIRED";
          job.finishedAt = now;
          counts.expired += 1;
          outstandingReservations -= 1;
        }
        break;
      }
    }
  }

  for (const job of arrivals) {
    if (job.finishedAt === undefined || job.finishedAt > config.durationMs) unfinishedAtHorizon += 1;
  }

  const durationSec = config.durationMs / 1000;
  return {
    label,
    config,
    arrived: arrivals.length,
    admitted: counts.admitted,
    rejected: counts.rejected,
    deferred: counts.deferred,
    expired: counts.expired,
    abandoned: counts.abandoned,
    completed: completedCount,
    completedInWindow,
    unfinishedAtHorizon,
    goodputPerSec: round(completedInWindow / durationSec),
    latency: percentiles(latencies),
    maxQueueDepth,
    maxQueueAgeMs: round(maxQueueAgeMs),
    peakConcurrency,
    rejectReasons,
    perTenant,
  };
}
