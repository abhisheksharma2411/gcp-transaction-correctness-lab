// Shared vocabulary for the admission lab.
//
// One "job" is one unit of protected work: the part of a checkout that touches
// inventory, a payment provider, and the database. Cheap, elastic work (page
// renders, static assets, catalogue reads) is deliberately not modelled. The
// whole point of the article is that those two classes of work must not share
// an admission policy.

export type TenantId = string;

/** What the admission controller decided to do with an arrival. */
export type Disposition =
  | "ADMITTED" // accepted into protected work
  | "REJECTED" // refused immediately, with a reason the caller can act on
  | "DEFERRED" // accepted as a reservation, to be completed asynchronously
  | "EXPIRED" // reservation was not completed before its deadline
  | "ABANDONED"; // caller gave up while waiting

export type RejectReason =
  | "QUEUE_FULL"
  | "PROJECTED_WAIT_EXCEEDS_PROMISE"
  | "TENANT_SHARE_EXCEEDED"
  | "NONE";

export interface Job {
  readonly id: number;
  readonly tenant: TenantId;
  /** Virtual milliseconds at which the caller arrived. */
  readonly arrivedAt: number;
  /** Service demand at the worker, in virtual milliseconds. */
  readonly serviceMs: number;
  /** Set when the job leaves the system, by any route. */
  finishedAt?: number;
  disposition?: Disposition;
  rejectReason?: RejectReason;
  /** Virtual ms spent waiting before service started. */
  waitedMs?: number;
}

export interface AdmissionPolicy {
  /**
   * Hard ceiling on jobs waiting for the constrained resource. A queue without
   * a bound is a backlog, not a queue; see the article's "durable queueing is
   * not an unlimited backlog" section.
   */
  readonly maxQueueDepth: number;
  /**
   * The promise made to the caller. An arrival whose projected wait exceeds
   * this is refused now rather than accepted and disappointed later.
   */
  readonly promiseMs: number;
  /**
   * Oldest-job age at which the controller sheds load regardless of depth.
   * Depth alone is a poor signal when service time degrades.
   */
  readonly maxQueueAgeMs: number;
  /**
   * Per-tenant ceiling as a fraction of queue capacity. Prevents one noisy
   * tenant from consuming the whole protected envelope.
   */
  readonly maxTenantShare: number;
  /**
   * Ceiling on outstanding reservations.
   *
   * Deferral is not a way to say yes to everything. A reservation backlog with
   * no bound is the unlimited-backlog anti-pattern wearing a different hat:
   * the caller is told "accepted" and then discovers hours later that it
   * expired. The first version of this controller had exactly that bug, and
   * experiment E9 caught it.
   */
  readonly maxReservations: number;
  /**
   * Project each tenant's wait from its own backlog and its own share of the
   * drain rate, rather than from the global queue.
   *
   * Set false to get global FIFO projection. Negative control N1 uses that to
   * show which of the two fairness mechanisms is actually doing the work: the
   * per-tenant ceiling bounds how much queue one tenant may occupy, but it is
   * this projection that keeps a small tenant being served while a large one
   * is being throttled.
   */
  readonly fairShareProjection: boolean;
}

export interface WorkerPolicy {
  /** Bounded concurrency at the constrained resource. */
  readonly concurrency: number;
  /**
   * Multiplicative service-time penalty applied per unit of concurrency above
   * `contentionKnee`. THIS IS A MODEL PARAMETER, NOT A MEASUREMENT of any
   * Google Cloud product. It exists so the envelope sweep can show that a knee
   * exists; its slope is an assumption and the article says so.
   */
  readonly contentionPerUnit: number;
  readonly contentionKnee: number;
}

/** A window of time during which arrival rates are constant. */
export interface Phase {
  readonly fromMs: number;
  readonly toMs: number;
  readonly ratePerSec: ReadonlyMap<TenantId, number>;
}

export interface SimConfig {
  readonly seed: number;
  readonly durationMs: number;
  /** Arrivals per second, per tenant. Ignored when `phases` is set. */
  readonly arrivalRatePerSec: ReadonlyMap<TenantId, number>;
  /** Time-varying load. Used for burst and recovery scenarios. */
  readonly phases?: readonly Phase[];
  /**
   * Service demand multiplier applied from this time onward, modelling a
   * dependency that slows down mid-run (a database under contention, a
   * provider degrading). 1 means no change.
   */
  readonly slowdownFromMs?: number;
  readonly slowdownFactor?: number;
  /** Mean service demand at the worker, virtual ms. */
  readonly meanServiceMs: number;
  readonly worker: WorkerPolicy;
  /** Omit to run open-loop: every arrival waits, nothing is ever refused. */
  readonly admission?: AdmissionPolicy;
  /** Caller patience. A caller who waits this long leaves. */
  readonly abandonAfterMs: number;
  /** Reservation lifetime for DEFERRED work. */
  readonly reservationTtlMs: number;
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface SimResult {
  readonly label: string;
  readonly config: SimConfig;
  readonly arrived: number;
  readonly admitted: number;
  readonly rejected: number;
  readonly deferred: number;
  readonly expired: number;
  readonly abandoned: number;
  readonly completed: number;
  /** Completions that landed inside the arrival window. */
  readonly completedInWindow: number;
  /** Jobs not finished by the end of the arrival window. */
  readonly unfinishedAtHorizon: number;
  /** Completed protected work per second, measured over the arrival window. */
  readonly goodputPerSec: number;
  /** Latency of work that actually completed. */
  readonly latency: Percentiles;
  readonly maxQueueDepth: number;
  readonly maxQueueAgeMs: number;
  readonly peakConcurrency: number;
  readonly rejectReasons: Readonly<Record<string, number>>;
  readonly perTenant: Readonly<Record<string, { admitted: number; rejected: number; completed: number }>>;
}
