// Durable timers, modelled on Cloud Tasks.
//
// A timer is not a `setTimeout`. It has to survive the death of the process
// that set it, which means it has to be a row somewhere that something else
// reads. Cloud Tasks gives that for free: a task carries a `scheduleTime`,
// documented as "The time when the task is scheduled to be attempted or
// retried", and the queue -- not your instance -- is what remembers it.
//
// The model keeps two properties of the real thing that matter here:
//
//  1. Delivery is at least once. "Cloud Tasks is designed to provide 'at least
//     once' delivery; that is, if a task is successfully added, the queue will
//     deliver it at least once. In some rare circumstances, multiple task
//     execution is possible." So a timer firing twice is normal, not a bug.
//  2. A name deduplicates. Naming the task after the thing it is a deadline
//     for is what stops two submissions arming two deadlines.

export interface Timer {
  readonly name: string;
  readonly payoutId: string;
  readonly fireAtMs: number;
  readonly createdAtMs: number;
}

export interface Fired {
  readonly timer: Timer;
  /** 1 for the first delivery, 2 for a redelivery. */
  readonly attempt: number;
}

export class TimerQueue {
  readonly #pending = new Map<string, Timer>();
  /** Names that have been used, so re-creating one is refused the way the API does. */
  readonly #seen = new Set<string>();
  #cancelled = 0;
  #duplicateCreates = 0;

  /**
   * Create a named timer.
   *
   * Returns `ALREADY_EXISTS` for a name already in use, mirroring the Cloud
   * Tasks create call. The caller treats that as success: the deadline it
   * wanted already exists, which is exactly what it was asking for.
   */
  schedule(timer: Timer): "CREATED" | "ALREADY_EXISTS" {
    const key = this.#key(timer.payoutId, timer.name);
    if (this.#seen.has(key)) {
      this.#duplicateCreates += 1;
      return "ALREADY_EXISTS";
    }
    this.#seen.add(key);
    this.#pending.set(key, timer);
    return "CREATED";
  }

  cancel(payoutId: string, name: string): boolean {
    const key = this.#key(payoutId, name);
    const had = this.#pending.delete(key);
    if (had) this.#cancelled += 1;
    return had;
  }

  /** Everything due at or before `nowMs`, in a deterministic order. */
  due(nowMs: number): readonly Timer[] {
    return [...this.#pending.values()]
      .filter((t) => t.fireAtMs <= nowMs)
      .sort((a, b) => a.fireAtMs - b.fireAtMs || (a.name < b.name ? -1 : 1));
  }

  /**
   * Deliver a due timer, optionally twice.
   *
   * `duplicate` models the "rare circumstances" the documentation warns about.
   * The second delivery is handed to the same handler and must be harmless.
   */
  deliver(timer: Timer, duplicate = false): readonly Fired[] {
    this.#pending.delete(this.#key(timer.payoutId, timer.name));
    return duplicate ? [{ timer, attempt: 1 }, { timer, attempt: 2 }] : [{ timer, attempt: 1 }];
  }

  get pendingCount(): number { return this.#pending.size; }
  get cancelledCount(): number { return this.#cancelled; }
  get duplicateCreateCount(): number { return this.#duplicateCreates; }

  #key(payoutId: string, name: string): string { return `${payoutId}/${name}`; }
}

/**
 * The deadline that the timer enforces is not the deadline the worker runs under.
 *
 * Cloud Tasks' `dispatchDeadline` is documented as cancelling the *request*:
 * "If the worker does not respond by this deadline then the request is
 * cancelled and the attempt is marked as a DEADLINE_EXCEEDED failure." And
 * then, in the same paragraph: "when the request is cancelled, Cloud Tasks
 * will stop listening for the response, but whether the worker stops
 * processing depends on the worker. For example, if the worker is stuck, it
 * may not react to cancelled requests."
 *
 * A timeout stops the waiting, not the work. That is why a stuck entity needs
 * a lease with an owner rather than a timeout alone: the timeout tells you
 * that nobody answered, and the lease tells you whether anybody is still
 * trying.
 */
export const DISPATCH_DEADLINE_NOTE =
  "a dispatch deadline cancels the request, not the worker";
