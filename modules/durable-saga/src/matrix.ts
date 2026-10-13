// The failure-matrix runner.
//
// One fault is injected at one point of one step, the saga is then driven to
// quiescence — restarting the orchestrator after a crash, delivering callbacks
// when they come due, and giving nothing to a human — and the result is scored
// twice: once by the saga's own record, and once by an auditor that reads only
// the participants' effect ledgers.
//
// A row where those two disagree is a defect. The matrix exists to produce
// such rows if they are there, not to confirm that they are not.

import { audit, outcomeOf, reconcile } from "./audit.ts";
import type { AuditResult, Outcome } from "./audit.ts";
import { DEFINITIONS } from "./saga.ts";
import type { Definition } from "./saga.ts";
import { FaultPlan, World } from "./participants.ts";
import type { Fault } from "./participants.ts";
import type { Mutation } from "./policy.ts";
import { DelayQueue, Orchestrator, SagaStore } from "./orchestrator.ts";
import type { Refusal } from "./orchestrator.ts";
import type { SagaRecord, SagaState, StepName } from "./types.ts";

/** Fixed start instant. Nothing in this module reads a clock. */
export const T0 = Date.parse("2026-04-07T09:00:00.000Z");
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const AMOUNT_MINOR = 128_400;
export const UNITS = 3;

/** Where a fault is injected. */
export type Injection = "reject" | "error" | "error-repeated" | "lost" | "crash" | "predispatch";

export const INJECTIONS: readonly Injection[] = [
  "reject", "error", "error-repeated", "lost", "crash", "predispatch",
];

export const INJECTION_MEANING: Readonly<Record<Injection, string>> = {
  reject: "the participant refuses, finally",
  error: "the participant is briefly unavailable",
  "error-repeated": "the participant stays unavailable until the attempts run out",
  lost: "the participant acts and the answer never arrives",
  crash: "the orchestrator dies after the answer and before recording it",
  predispatch: "the orchestrator dies before the command leaves",
};

function faultFor(step: StepName, direction: "forward" | "compensate", inj: Injection): Fault {
  switch (inj) {
    case "reject": return { step, direction, at: "reject" };
    case "error": return { step, direction, at: "error" };
    case "error-repeated": return { step, direction, at: "error", sticky: true };
    case "lost": return { step, direction, at: "lost" };
    case "crash": return { step, direction, at: "crash" };
    case "predispatch": return { step, direction, at: "predispatch" };
  }
}

export interface RunOptions {
  readonly mutation?: Mutation;
  readonly version?: 1 | 2;
  readonly faults?: readonly Fault[];
  readonly dedupe?: boolean;
  readonly callbackDelayMs?: number;
  /** Operator actions applied once the saga stops in a state a human owns. */
  readonly repair?: "retry" | "resume" | "close";
  /** Request cancellation while this step's command is in flight. */
  readonly cancelDuring?: StepName;
  /** Request cancellation the first time the saga blocks on a callback. */
  readonly cancelWhileWaiting?: boolean;
}

export interface Run {
  readonly world: World;
  readonly store: SagaStore;
  readonly queue: DelayQueue;
  readonly record: SagaRecord;
  readonly refusals: readonly Refusal[];
  readonly restarts: number;
  readonly rounds: number;
  readonly audit: AuditResult;
  readonly disagreement: string | null;
  readonly definition: Definition;
}

/**
 * Drive one saga from start to quiescence.
 *
 * "Quiescence" means: finished, or stopped in a state only an operator can
 * leave, or out of rounds. The orchestrator is reconstructed after every
 * crash, which is the only way to be sure that nothing it needs is held in
 * memory.
 */
export function run(id: string, opts: RunOptions = {}): Run {
  // De-duplication lives at the participant, so switching it off is a
  // property of the world rather than of the orchestrator. Article 12 owns the
  // contract; this module owns only the consequence of not having it.
  const dedupe = opts.dedupe ?? (opts.mutation !== "no-step-dedupe");
  const world = new World(new FaultPlan(opts.faults ?? []), dedupe);
  const store = new SagaStore();
  const queue = new DelayQueue();
  const version = opts.version ?? 1;
  const def = DEFINITIONS[version];
  const refusals: Refusal[] = [];

  const build = (): Orchestrator => new Orchestrator(store, world, queue, {
    ...(opts.mutation === undefined ? {} : { mutation: opts.mutation }),
    ...(opts.callbackDelayMs === undefined ? {} : { callbackDelayMs: opts.callbackDelayMs }),
    ...(opts.cancelDuring === undefined ? {} : { cancelDuring: opts.cancelDuring }),
  });

  let orch = build();
  let now = T0;
  let restarts = 0;
  let rounds = 0;
  let repaired = false;
  let cancelledWhileWaiting = false;
  orch.start(id, AMOUNT_MINOR, UNITS, now, version);

  for (; rounds < 24; rounds += 1) {
    const r = orch.advance(id, now);
    now += MINUTE;
    if (r === "crashed") {
      refusals.push(...orch.refusals);
      orch = build();
      restarts += 1;
      now += 5 * MINUTE;
      continue;
    }
    if (r === "blocked") {
      if (opts.cancelWhileWaiting === true && !cancelledWhileWaiting) {
        cancelledWhileWaiting = true;
        orch.cancel(id, now);
        continue;
      }
      const next = queue.items.map((i) => i.dueMs).sort((a, b) => a - b)[0];
      if (next === undefined) break;
      now = Math.max(now, next);
      orch.runDue(now);
      continue;
    }
    if (r === "stopped") {
      if (opts.repair === undefined || repaired) break;
      repaired = true;
      orch.operator(id, opts.repair, now);
      continue;
    }
    break;
  }

  // Anything still in the queue is delivered after the saga has stopped. That
  // is not tidying up: a carrier answering a request the saga gave up on is
  // the single most interesting message in the system, and a run that ended
  // without hearing it would have skipped the test.
  if (queue.pendingCount > 0) {
    const last = queue.items.map((i) => i.dueMs).sort((a, b) => b - a)[0]!;
    orch.runDue(Math.max(now, last));
  }

  refusals.push(...orch.refusals);
  const record = store.get(id);
  const result = audit(def, world.allRecords(), id);
  return {
    world, store, queue, record, refusals, restarts, rounds,
    audit: result, disagreement: reconcile(record.state, result), definition: def,
  };
}

export interface MatrixRow {
  readonly step: StepName;
  readonly direction: "forward" | "compensate";
  readonly injection: Injection;
  readonly finalState: SagaState;
  readonly outcome: Outcome;
  readonly verdict: AuditResult["verdict"];
  readonly agreed: boolean;
  readonly disagreement: string | null;
  readonly liveEffects: readonly StepName[];
  readonly restarts: number;
  readonly duplicateEffects: number;
}

function rowFor(
  id: string, step: StepName, direction: "forward" | "compensate",
  inj: Injection, opts: RunOptions,
): MatrixRow {
  const r = run(id, { ...opts, faults: [faultFor(step, direction, inj)] });
  const dupes = r.audit.violations.filter((v) => v.code === "DUPLICATE_EFFECT").length;
  return {
    step, direction, injection: inj,
    finalState: r.record.state, outcome: outcomeOf(r.record.state),
    verdict: r.audit.verdict, agreed: r.disagreement === null,
    disagreement: r.disagreement, liveEffects: r.audit.live,
    restarts: r.restarts, duplicateEffects: dupes,
  };
}

/**
 * Every forward injection point on every step, then every compensation
 * refused outright.
 *
 * The compensation rows are driven by a refusal on the compensating command
 * for a step the saga has already taken, which needs a second fault to make
 * the saga compensate at all; that is `authorize_payment` being refused.
 */
export function failureMatrix(opts: RunOptions = {}): readonly MatrixRow[] {
  const def = DEFINITIONS[opts.version ?? 1];
  const rows: MatrixRow[] = [];
  for (const step of def.steps) {
    for (const inj of INJECTIONS) {
      rows.push(rowFor(`fm-${step.name}-${inj}`, step.name, "forward", inj, opts));
    }
  }
  for (const step of def.steps) {
    if (step.compensation === null) continue;
    const id = `fm-comp-${step.name}`;
    const r = run(id, {
      ...opts,
      faults: [
        { step: "capture_payment", direction: "forward", at: "reject" },
        { step: step.compensation, direction: "compensate", at: "reject", sticky: true },
      ],
    });
    const dupes = r.audit.violations.filter((v) => v.code === "DUPLICATE_EFFECT").length;
    rows.push({
      step: step.compensation, direction: "compensate", injection: "reject",
      finalState: r.record.state, outcome: outcomeOf(r.record.state),
      verdict: r.audit.verdict, agreed: r.disagreement === null,
      disagreement: r.disagreement, liveEffects: r.audit.live,
      restarts: r.restarts, duplicateEffects: dupes,
    });
  }
  return rows;
}

export function tally(rows: readonly MatrixRow[]): Readonly<Record<Outcome, number>> {
  const t: Record<Outcome, number> = { COMPLETED: 0, COMPENSATED: 0, MANUAL: 0, PENDING: 0 };
  for (const r of rows) t[r.outcome] += 1;
  return t;
}

/** One saga's history, rendered. */
export function timeline(rec: SagaRecord): readonly string[] {
  return rec.history.map((h) => {
    const t = new Date(h.atMs).toISOString().slice(11, 19);
    const step = h.step === "" ? "—" : h.step;
    return `${String(h.seq).padStart(2, "0")} | ${t} | ${h.kind} | ${step} | ${h.reasonCode} | ${h.detail}`;
  });
}
