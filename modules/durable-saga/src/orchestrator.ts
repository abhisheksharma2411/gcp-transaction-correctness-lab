// The orchestrator. It owns the saga record and nothing else.
//
// Everything durable about a saga is in the `SagaStore`, so "the orchestrator
// restarted" is modelled by throwing this object away and building another one
// over the same store. That is the only honest way to test restart recovery in
// a single process, and it is why no field below holds anything the store does
// not.
//
// Three decisions are worth reading the code for.
//
//   1. The compensation chain is driven by what was *dispatched*, not by what
//      *succeeded*. A step whose answer never arrived has, as far as anyone
//      here knows, happened.
//   2. Compensations are resolved against the definition version the saga is
//      pinned to, not the current one. Article 13 owns pinning; what is
//      specific to a saga is that the code for a deleted step's compensation
//      has to stay deployed.
//   3. An unknown outcome is resolved by asking the participant what it
//      recorded, never by assuming. Article 1 owns that argument.

import {
  DEFINITIONS, MAX_COMPENSATION_ATTEMPTS, isTerminal, stepByName, transitionFor,
} from "./saga.ts";
import type { Definition, Step } from "./saga.ts";
import type { Mutation } from "./policy.ts";
import { World } from "./participants.ts";
import type { Command, Outcome, SagaEvent, SagaRecord, SagaState, SagaTrigger, StepName } from "./types.ts";

/** Nothing outside this file writes to a saga record. */
export class SagaStore {
  readonly rows: Map<string, SagaRecord> = new Map();

  get(id: string): SagaRecord {
    const r = this.rows.get(id);
    if (r === undefined) throw new Error(`no saga ${id}`);
    return r;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  put(r: SagaRecord): void {
    this.rows.set(r.id, r);
  }
}

/** One scheduled delivery. The virtual stand-in for a task or a callback. */
export interface ScheduledItem {
  readonly dueMs: number;
  readonly sagaId: string;
  readonly step: StepName;
  readonly token: string;
  readonly seq: number;
}

/**
 * A delayed-delivery queue with a virtual clock.
 *
 * It stands in for a Cloud Tasks queue or a workflow callback. It is
 * deliberately not a durable timer: Article 13 owns timers, and this module
 * only needs something that makes an answer arrive later than the request.
 */
export class DelayQueue {
  readonly items: ScheduledItem[] = [];
  readonly delivered: ScheduledItem[] = [];
  seq = 0;

  schedule(sagaId: string, step: StepName, token: string, dueMs: number): void {
    this.seq += 1;
    this.items.push({ dueMs, sagaId, step, token, seq: this.seq });
  }

  /** Items due at or before `nowMs`, oldest first, removed from the queue. */
  drain(nowMs: number): readonly ScheduledItem[] {
    const due = this.items
      .filter((i) => i.dueMs <= nowMs)
      .sort((a, b) => (a.dueMs - b.dueMs) || (a.seq - b.seq));
    for (const d of due) this.items.splice(this.items.indexOf(d), 1);
    this.delivered.push(...due);
    return due;
  }

  get pendingCount(): number {
    return this.items.length;
  }
}

export type AdvanceResult = "blocked" | "finished" | "crashed" | "stopped" | "budget";

export interface Refusal {
  readonly sagaId: string;
  readonly code: string;
  readonly detail: string;
}

export interface OrchestratorOptions {
  readonly mutation?: Mutation;
  /** How long the carrier takes to answer. Virtual milliseconds. */
  readonly callbackDelayMs?: number;
  /**
   * Request cancellation while this step's command is in flight.
   *
   * This is the race, modelled honestly: the request is accepted by a saga
   * that is still RUNNING, and by the time anyone looks at the flag the
   * participant has already committed the pivot.
   */
  readonly cancelDuring?: StepName;
}

const DEFAULT_CALLBACK_DELAY_MS = 90 * 60 * 1000;
const LOOP_BUDGET = 60;

export class Orchestrator {
  readonly store: SagaStore;
  readonly world: World;
  readonly queue: DelayQueue;
  readonly mutation: Mutation | null;
  readonly callbackDelayMs: number;
  readonly cancelDuring: StepName | null;
  readonly refusals: Refusal[] = [];
  /** Commands actually handed to the world by this instance. */
  readonly dispatches: string[] = [];

  constructor(store: SagaStore, world: World, queue: DelayQueue, opts: OrchestratorOptions = {}) {
    this.store = store;
    this.world = world;
    this.queue = queue;
    this.mutation = opts.mutation ?? null;
    this.callbackDelayMs = opts.callbackDelayMs ?? DEFAULT_CALLBACK_DELAY_MS;
    this.cancelDuring = opts.cancelDuring ?? null;
  }

  has(m: Mutation): boolean {
    return this.mutation === m;
  }

  definitionOf(rec: SagaRecord): Definition {
    return DEFINITIONS[rec.specVersion];
  }

  // --- lifecycle -----------------------------------------------------------

  start(id: string, amountMinor: number, units: number, nowMs: number, version: 1 | 2 = 1): SagaRecord {
    const rec: SagaRecord = {
      id, specVersion: version, state: "RUNNING", cursor: 0,
      dispatched: [], completed: [], compensated: [], attempts: {},
      callbackToken: null, callbackStep: null, cancelRequested: false,
      amountMinor, units, history: [],
    };
    this.store.put(rec);
    this.record(rec, nowMs, "transition", "", "saga started", "STARTED");
    return rec;
  }

  // --- the record ----------------------------------------------------------

  record(
    rec: SagaRecord, atMs: number, kind: SagaEvent["kind"], step: StepName,
    detail: string, reasonCode: string,
  ): void {
    rec.history.push({ seq: rec.history.length + 1, atMs, kind, step, detail, reasonCode });
  }

  transition(rec: SagaRecord, trigger: SagaTrigger, atMs: number): boolean {
    const def = this.definitionOf(rec);
    const t = transitionFor(def, rec.state, trigger);
    if (t === undefined) {
      this.refuse(rec, atMs, "NO_SUCH_TRANSITION", `${rec.state} has no row for ${trigger}`);
      return false;
    }
    rec.state = t.to;
    // Leaving RUNNING ends every outstanding wait. A saga that has started
    // compensating is not waiting for a carrier any more, and leaving the
    // token in place would let an answer it no longer wants walk back in.
    if (t.from === "RUNNING" && rec.callbackToken !== null) {
      this.record(rec, atMs, "callback_refused", rec.callbackStep ?? "",
        "the wait ended when the saga left RUNNING", "WAIT_ABANDONED");
      rec.callbackToken = null;
      rec.callbackStep = null;
    }
    this.record(rec, atMs, "transition", "", `${t.from} --${trigger}--> ${t.to}`, t.reasonCode);
    return true;
  }

  refuse(rec: SagaRecord, atMs: number, code: string, detail: string): void {
    this.refusals.push({ sagaId: rec.id, code, detail });
    this.record(rec, atMs, "refused", "", detail, code);
  }

  // --- commands ------------------------------------------------------------

  command(rec: SagaRecord, step: Step, direction: "forward" | "compensate", attempt: number): Command {
    const name = direction === "forward" ? step.name : (step.compensation ?? step.name);
    return {
      sagaId: rec.id, step: name,
      commandId: `${rec.id}:${direction}:${name}`,
      direction, amountMinor: rec.amountMinor, units: rec.units, attempt,
    };
  }

  attemptCount(rec: SagaRecord, key: string): number {
    const n = (rec.attempts[key] ?? 0) + 1;
    rec.attempts[key] = n;
    return n;
  }

  capFor(step: Step, direction: "forward" | "compensate"): number {
    if (this.has("no-attempt-cap")) return Number.MAX_SAFE_INTEGER;
    return direction === "forward" ? step.maxAttempts : MAX_COMPENSATION_ATTEMPTS;
  }

  // --- the loop ------------------------------------------------------------

  /**
   * Drive one saga as far as it will go.
   *
   * Returns why it stopped: waiting for a callback, finished, crashed in the
   * middle of a step, stopped in a state an operator owns, or out of budget.
   */
  advance(id: string, nowMs: number): AdvanceResult {
    const rec = this.store.get(id);
    const def = this.definitionOf(rec);

    for (let i = 0; i < LOOP_BUDGET; i += 1) {
      if (isTerminal(def, rec.state)) return "finished";
      if (rec.state === "MANUAL_REPAIR" || rec.state === "COMPENSATION_FAILED") return "stopped";

      if (rec.state === "COMPENSATING") {
        const r = this.compensateOnce(rec, nowMs + i);
        if (r !== null) return r;
        continue;
      }

      // RUNNING or PIVOTED.
      if (rec.cancelRequested) {
        rec.cancelRequested = false;
        if (rec.state === "RUNNING") {
          this.transition(rec, "cancel_requested", nowMs + i);
          continue;
        }
        if (this.has("no-pivot-cancel-check")) {
          // Without the guard the saga simply starts undoing a committed
          // process, and finds out from the payment service that it cannot.
          rec.state = "COMPENSATING";
          this.record(rec, nowMs + i, "transition", "", "forced into COMPENSATING after the pivot", "CANCELLED_AFTER_PIVOT");
          continue;
        }
        // The request was accepted while the saga was still compensable and
        // read after the pivot committed. The cancellation loses, and the
        // record says so rather than quietly dropping it.
        this.refuse(rec, nowMs + i, "CANCEL_LOST_THE_RACE",
          "the pivot committed while the cancellation was in flight");
      }
      if (rec.callbackToken !== null) return "blocked";

      const step = def.steps[rec.cursor];
      if (step === undefined) {
        this.transition(rec, "forward_complete", nowMs + i);
        continue;
      }
      const r = this.forwardOnce(rec, step, nowMs + i);
      if (r !== null) return r;
    }
    return "budget";
  }

  /** One forward attempt. Returns null to keep going. */
  forwardOnce(rec: SagaRecord, step: Step, nowMs: number): AdvanceResult | null {
    const key = `forward:${step.name}`;
    const attempt = this.attemptCount(rec, key);
    if (attempt > this.capFor(step, "forward")) {
      return this.forwardGaveUp(rec, step, nowMs, "attempts exhausted");
    }

    if (this.world.faults.take(step.name, "forward", "predispatch")) {
      this.record(rec, nowMs, "step_dispatched", step.name, "crashed before the command left", "CRASH_PREDISPATCH");
      return "crashed";
    }

    const cmd = this.command(rec, step, "forward", attempt);
    this.dispatches.push(cmd.commandId);
    rec.dispatched.push(step.name);
    this.record(rec, nowMs, "step_dispatched", step.name, `attempt ${attempt} to ${step.participant}`, "DISPATCHED");

    let out: Outcome = this.world.send(step.participant, cmd, nowMs);
    if (this.cancelDuring === step.name) this.cancel(rec.id, nowMs);
    if (this.world.faults.take(step.name, "forward", "lost")) {
      out = { kind: "unknown", reason: "no response from the participant" };
    }
    if (this.world.faults.take(step.name, "forward", "crash")) {
      this.record(rec, nowMs, "step_dispatched", step.name, "crashed before recording the answer", "CRASH_PRERECORD");
      return "crashed";
    }
    return this.applyForward(rec, step, cmd, out, nowMs);
  }

  applyForward(
    rec: SagaRecord, step: Step, cmd: Command, out: Outcome, nowMs: number,
  ): AdvanceResult | null {
    switch (out.kind) {
      case "accepted": {
        rec.completed.push(step.name);
        rec.cursor += 1;
        this.record(rec, nowMs, "step_accepted", step.name,
          out.duplicate ? "accepted as a duplicate" : `accepted as ${out.effectId}`, "STEP_ACCEPTED");
        if (step.pivot) this.transition(rec, "pivot_committed", nowMs);
        return null;
      }
      case "pending": {
        rec.callbackToken = out.callbackToken;
        rec.callbackStep = step.name;
        this.queue.schedule(rec.id, step.name, out.callbackToken, nowMs + this.callbackDelayMs);
        this.record(rec, nowMs, "step_pending", step.name,
          `waiting for ${step.participant} to call back`, "AWAITING_CALLBACK");
        return "blocked";
      }
      case "rejected": {
        this.record(rec, nowMs, "step_rejected", step.name, `${out.code}: ${out.reason}`, out.code);
        return this.forwardGaveUp(rec, step, nowMs, out.code);
      }
      case "error": {
        this.record(rec, nowMs, "step_error", step.name, `${out.code}: ${out.reason}`, out.code);
        return null;
      }
      case "unknown": {
        this.record(rec, nowMs, "step_unknown", step.name, out.reason, "OUTCOME_UNKNOWN");
        const status = this.world.statusOf(step.participant, rec.id, cmd.step);
        this.record(rec, nowMs, "step_resolved", step.name, `participant says ${status}`, "RESOLVED_BY_LOOKUP");
        if (status === "applied") {
          rec.completed.push(step.name);
          rec.cursor += 1;
          if (step.pivot) this.transition(rec, "pivot_committed", nowMs);
        }
        return null;
      }
    }
  }

  forwardGaveUp(rec: SagaRecord, step: Step, nowMs: number, why: string): AdvanceResult | null {
    if (rec.state === "PIVOTED") {
      this.record(rec, nowMs, "step_rejected", step.name, `no way back: ${why}`, "FORWARD_EXHAUSTED");
      this.transition(rec, "forward_exhausted", nowMs);
      return "stopped";
    }
    this.transition(rec, "step_failed", nowMs);
    return null;
  }

  // --- compensation --------------------------------------------------------

  /**
   * The chain, one link at a time.
   *
   * The list it walks is the list of steps that were *sent*, which is the
   * whole argument: a step whose answer never came back may well have
   * happened, and a chain built from confirmations would walk straight past
   * it.
   */
  pendingCompensations(rec: SagaRecord): readonly StepName[] {
    const def = this.definitionOf(rec);
    const source = this.has("compensate-only-confirmed") ? rec.completed : rec.dispatched;
    const seen = new Set<StepName>();
    const names: StepName[] = [];
    for (const n of source) {
      if (seen.has(n)) continue;
      seen.add(n);
      names.push(n);
    }
    const ordered = this.has("forward-compensation-order") ? names : names.slice().reverse();
    return ordered.filter((n) => {
      const s = stepByName(def, n);
      return s !== undefined && s.compensation !== null && !rec.compensated.includes(n);
    });
  }

  compensateOnce(rec: SagaRecord, nowMs: number): AdvanceResult | null {
    const next = this.pendingCompensations(rec)[0];
    if (next === undefined) {
      this.transition(rec, "compensations_complete", nowMs);
      return null;
    }
    // Pinned, unless the mutation says otherwise. A saga that resolves its
    // compensations against the current definition cannot undo a step the
    // current definition has deleted.
    const lookIn = this.has("compensate-with-current-spec") ? DEFINITIONS[2] : this.definitionOf(rec);
    const step = stepByName(lookIn, next);
    if (step === undefined || step.compensation === null) {
      this.record(rec, nowMs, "compensation_failed", next,
        "the current definition has no compensation for this step", "UNKNOWN_COMPENSATION");
      this.transition(rec, "compensation_exhausted", nowMs);
      return "stopped";
    }

    const key = `compensate:${step.name}`;
    const attempt = this.attemptCount(rec, key);
    if (attempt > this.capFor(step, "compensate")) {
      this.record(rec, nowMs, "compensation_failed", step.name, "attempts exhausted", "COMPENSATION_EXHAUSTED");
      this.transition(rec, "compensation_exhausted", nowMs);
      return "stopped";
    }

    const cmd = this.command(rec, step, "compensate", attempt);
    this.record(rec, nowMs, "compensation_dispatched", step.name,
      `attempt ${attempt}: ${step.compensation} to ${step.participant}`, "COMPENSATION_DISPATCHED");

    if (this.has("orchestrator-forgets-compensation")) {
      // The record claims the work was done and nothing was sent. Only a party
      // that reads the participant's ledger can see this.
      rec.compensated.push(step.name);
      this.record(rec, nowMs, "compensation_accepted", step.name, "recorded without sending", "COMPENSATION_ACCEPTED");
      return null;
    }

    this.dispatches.push(cmd.commandId);
    const out = this.world.send(step.participant, cmd, nowMs);
    if (out.kind === "accepted") {
      rec.compensated.push(step.name);
      this.record(rec, nowMs, "compensation_accepted", step.name,
        out.duplicate ? "accepted as a duplicate" : `accepted as ${out.effectId}`, "COMPENSATION_ACCEPTED");
      return null;
    }
    const code = out.kind === "rejected" || out.kind === "error" ? out.code : "OUTCOME_UNKNOWN";

    // A refusal is not the end of it. The participant may be saying that there
    // is nothing to undo, which is a completed compensation and not a failed
    // one, and the only way to tell is to ask what it recorded. This is the
    // same lookup an unknown forward outcome needs, for the same reason.
    if (out.kind === "rejected" && this.world.statusOf(step.participant, rec.id, step.name) === "absent") {
      rec.compensated.push(step.name);
      this.record(rec, nowMs, "compensation_accepted", step.name,
        `${code}; the participant has no effect to undo`, "NOTHING_TO_UNDO");
      return null;
    }
    this.record(rec, nowMs, "compensation_failed", step.name, code, code);
    return null;
  }

  // --- callbacks -----------------------------------------------------------

  /**
   * The carrier answers.
   *
   * Two checks stand between the answer and the saga: there has to be an
   * outstanding wait, and the token has to be the one this wait is expecting.
   * Both are removed by the `no-wait-correlation` mutation, and the refusal
   * codes they produce are what the control asserts.
   */
  deliverCallback(id: string, step: StepName, token: string, nowMs: number): "accepted" | "refused" {
    const rec = this.store.get(id);
    const def = this.definitionOf(rec);
    const strict = !this.has("no-wait-correlation");

    const s = stepByName(def, step);
    if (s === undefined) {
      this.refuse(rec, nowMs, "NO_SUCH_STEP", `${step} is not in version ${rec.specVersion}`);
      return "refused";
    }

    // The carrier acts first. Whether anyone here is still listening is this
    // system's problem and not the carrier's, so the participant is asked
    // before the saga's own correlation checks run. The only thing that stops
    // a booking the saga no longer wants is the compensation that was sent to
    // the participant earlier — not a check on this side of the wire.
    const cmd = this.command(rec, s, "forward", 1);
    const out = this.world.deliverBooking(cmd, token, nowMs);

    if (strict && rec.callbackToken === null) {
      this.refuse(rec, nowMs, "NO_WAIT_OUTSTANDING", `${id} is not waiting for a callback`);
      this.record(rec, nowMs, "callback_refused", step,
        out.kind === "accepted" ? "no outstanding wait, and the participant acted anyway" : "no outstanding wait",
        "NO_WAIT_OUTSTANDING");
      return "refused";
    }
    if (strict && rec.callbackToken !== token) {
      this.refuse(rec, nowMs, "CALLBACK_UNCORRELATED", `token ${token} does not match the outstanding wait`);
      this.record(rec, nowMs, "callback_refused", step, "token does not match", "CALLBACK_UNCORRELATED");
      return "refused";
    }
    rec.callbackToken = null;
    rec.callbackStep = null;

    if (out.kind === "accepted") {
      rec.completed.push(step);
      rec.cursor += 1;
      this.record(rec, nowMs, "callback_accepted", step, `confirmed as ${out.effectId}`, "CALLBACK_ACCEPTED");
      return "accepted";
    }
    const code = out.kind === "rejected" || out.kind === "error" ? out.code : "OUTCOME_UNKNOWN";
    this.record(rec, nowMs, "callback_refused", step, code, code);
    if (rec.state === "RUNNING") this.transition(rec, "step_failed", nowMs);
    return "refused";
  }

  /** Deliver everything the queue says is due. */
  runDue(nowMs: number): number {
    const due = this.queue.drain(nowMs);
    for (const d of due) this.deliverCallback(d.sagaId, d.step, d.token, d.dueMs);
    return due.length;
  }

  // --- cancellation --------------------------------------------------------

  /**
   * A cancellation request, which may lose.
   *
   * The race this models is the one that matters: a customer presses cancel
   * while the pivot is in flight. The saga does not guess. If the pivot is
   * recorded as committed it refuses, and if the answer never arrived it asks
   * the participant before deciding.
   */
  cancel(id: string, nowMs: number): "accepted" | "refused" {
    const rec = this.store.get(id);
    const def = this.definitionOf(rec);
    if (isTerminal(def, rec.state)) {
      this.refuse(rec, nowMs, "SAGA_FINISHED", `${rec.state} is terminal`);
      return "refused";
    }
    const guard = !this.has("no-pivot-cancel-check");
    if (guard && rec.state !== "RUNNING") {
      this.refuse(rec, nowMs, "CANCEL_AFTER_PIVOT", `the saga is ${rec.state}; a reversal is a new process`);
      return "refused";
    }
    rec.cancelRequested = true;
    this.record(rec, nowMs, "operator", "", "cancellation requested", "CANCEL_REQUESTED");
    return "accepted";
  }

  // --- the operator --------------------------------------------------------

  operator(id: string, action: "retry" | "resume" | "close", nowMs: number): boolean {
    const rec = this.store.get(id);
    const trigger: SagaTrigger =
      action === "retry" ? "operator_retried"
        : action === "resume" ? "operator_resumed"
          : "operator_closed";
    if (action === "retry") {
      // The repair resumes the chain. It does not reset what already has a
      // record, which is what stops a repair from paying twice.
      for (const k of Object.keys(rec.attempts)) {
        if (k.startsWith("compensate:")) rec.attempts[k] = 0;
      }
    }
    if (action === "resume") {
      for (const k of Object.keys(rec.attempts)) {
        if (k.startsWith("forward:")) rec.attempts[k] = 0;
      }
    }
    this.record(rec, nowMs, "operator", "", `operator ${action}`, "OPERATOR_ACTION");
    return this.transition(rec, trigger, nowMs);
  }

  stateOf(id: string): SagaState {
    return this.store.get(id).state;
  }
}
