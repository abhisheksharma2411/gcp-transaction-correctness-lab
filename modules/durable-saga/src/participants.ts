// Five service simulators. Each owns its own store, its own effect ledger, and
// its own opinion about what it will refuse.
//
// They are deliberately unhelpful in the way real services are: inventory
// refuses to release stock that a live shipment still depends on, payments
// refuses to void an authorization it has already captured, and fulfilment
// answers later rather than now. None of them knows what a saga is.
//
// De-duplication is one line per participant: the command id arrives as a
// string and is stored as a string. Article 12 owns the contract that produces
// that string; nothing here re-derives it, so a bug in the orchestrator's
// minting cannot be hidden by the participant agreeing with it.

import type { Command, EffectRecord, Outcome, Participant, StepName } from "./types.ts";

/** A scripted failure, consumed the first time it matches. */
export interface Fault {
  readonly step: StepName;
  readonly direction: "forward" | "compensate";
  /**
   * Where the run breaks.
   *
   * `reject`  -- the participant says no, finally
   * `error`   -- the participant says no, for now
   * `lost`    -- the participant acts and the answer never arrives
   * `crash`   -- the orchestrator dies after the answer and before recording it
   * `predispatch` -- the orchestrator dies before the command leaves
   */
  readonly at: "reject" | "error" | "lost" | "crash" | "predispatch";
  /** Repeat the fault instead of consuming it. Used to exhaust attempts. */
  readonly sticky?: boolean;
}

export class FaultPlan {
  readonly faults: Fault[];
  readonly fired: string[] = [];

  constructor(faults: readonly Fault[] = []) {
    this.faults = [...faults];
  }

  take(step: StepName, direction: "forward" | "compensate", at: Fault["at"]): boolean {
    const i = this.faults.findIndex(
      (f) => f.step === step && f.direction === direction && f.at === at,
    );
    if (i < 0) return false;
    const f = this.faults[i]!;
    this.fired.push(`${direction}:${step}:${at}`);
    if (f.sticky !== true) this.faults.splice(i, 1);
    return true;
  }

  pending(): readonly Fault[] {
    return this.faults;
  }
}

/** The read-only view the auditor gets. It can see records and nothing else. */
export interface EffectLedger {
  records(): readonly EffectRecord[];
}

/** One participant's store. */
class Store implements EffectLedger {
  readonly who: Participant;
  readonly rows: EffectRecord[] = [];
  /** command id -> effect id, the entire de-duplication mechanism. */
  readonly seen: Map<string, string> = new Map();

  constructor(who: Participant) {
    this.who = who;
  }

  records(): readonly EffectRecord[] {
    return this.rows;
  }

  /** Returns the existing effect id when this command id has been seen. */
  replay(c: Command, dedupe: boolean): string | null {
    if (!dedupe) return null;
    return this.seen.get(c.commandId) ?? null;
  }

  write(c: Command, kind: "applied" | "compensated", nowMs: number, detail: string): string {
    const effectId = `${this.who}-${this.rows.length + 1}`;
    this.seen.set(c.commandId, effectId);
    this.rows.push({
      participant: this.who, sagaId: c.sagaId, step: c.step, kind,
      commandId: c.commandId, atMs: nowMs, detail,
    });
    return effectId;
  }
}

/**
 * The five services, plus the mechanics that make them answer.
 *
 * `dedupe` is a switch rather than a constant because removing it is one of
 * the negative controls: a saga whose participants do not de-duplicate must
 * produce a visible second effect, or the tests that claim to check for one
 * are measuring nothing.
 */
export class World {
  readonly stores: Record<Participant, Store> = {
    inventory: new Store("inventory"),
    payments: new Store("payments"),
    fulfilment: new Store("fulfilment"),
    ledger: new Store("ledger"),
    notifications: new Store("notifications"),
  };

  readonly faults: FaultPlan;
  readonly dedupe: boolean;
  /** Every command the world received, in order. Used only for reporting. */
  readonly wire: string[] = [];

  // inventory
  held: Map<string, number> = new Map();
  // payments: saga -> hold state
  holds: Map<string, "held" | "voided" | "captured"> = new Map();
  // fulfilment: saga -> booking state
  bookings: Map<string, "none" | "requested" | "booked" | "cancelled"> = new Map();
  callbackTokens: Map<string, string> = new Map();

  constructor(faults: FaultPlan = new FaultPlan(), dedupe = true) {
    this.faults = faults;
    this.dedupe = dedupe;
  }

  ledgerOf(who: Participant): EffectLedger {
    return this.stores[who];
  }

  allRecords(): readonly EffectRecord[] {
    const out: EffectRecord[] = [];
    for (const k of Object.keys(this.stores) as Participant[]) out.push(...this.stores[k].rows);
    return out.slice().sort((a, b) => (a.atMs - b.atMs) || a.participant.localeCompare(b.participant));
  }

  /** The booking state, for a test that needs to see it. */
  bookingState(sagaId: string): string {
    return this.bookings.get(sagaId) ?? "none";
  }

  holdState(sagaId: string): string {
    return this.holds.get(sagaId) ?? "none";
  }

  heldUnits(sagaId: string): number {
    return this.held.get(sagaId) ?? 0;
  }

  /**
   * Deliver one command to the participant that owns the step.
   *
   * The orchestrator calls this and nothing else. It does not reach into a
   * store, and it never learns an effect id it was not told.
   */
  send(who: Participant, c: Command, nowMs: number): Outcome {
    this.wire.push(`${nowMs}:${who}:${c.direction}:${c.step}:${c.commandId}`);

    const replayed = this.stores[who].replay(c, this.dedupe);
    if (replayed !== null) {
      return { kind: "accepted", effectId: replayed, duplicate: true };
    }
    if (this.faults.take(c.step, c.direction, "reject")) {
      return { kind: "rejected", code: "REFUSED", reason: `${who} refused ${c.step}` };
    }
    if (this.faults.take(c.step, c.direction, "error")) {
      return { kind: "error", code: "UNAVAILABLE", reason: `${who} is unavailable` };
    }

    switch (who) {
      case "inventory": return this.inventory(c, nowMs);
      case "payments": return this.payments(c, nowMs);
      case "fulfilment": return this.fulfilment(c, nowMs);
      case "ledger": return this.ledgerService(c, nowMs);
      case "notifications": return this.notifications(c, nowMs);
    }
  }

  /**
   * What the participant says it did, when asked later.
   *
   * This is the lookup an orchestrator needs after a lost response, and it is
   * the only way out of an unknown outcome that does not involve guessing.
   */
  statusOf(who: Participant, sagaId: string, step: StepName): "applied" | "compensated" | "absent" {
    const rows = this.stores[who].rows.filter((r) => r.sagaId === sagaId && r.step === step);
    const comp = rows.find((r) => r.kind === "compensated");
    if (comp !== undefined) return "compensated";
    return rows.length > 0 ? "applied" : "absent";
  }

  // --- inventory -----------------------------------------------------------

  inventory(c: Command, nowMs: number): Outcome {
    if (c.direction === "forward") {
      this.held.set(c.sagaId, (this.held.get(c.sagaId) ?? 0) + c.units);
      return { kind: "accepted", effectId: this.stores.inventory.write(c, "applied", nowMs, `held ${c.units} units`), duplicate: false };
    }
    // Releasing stock that a live shipment still depends on is refused. This
    // is why compensation order is a property of the business and not a
    // preference of the orchestrator.
    if (this.bookings.get(c.sagaId) === "booked") {
      return { kind: "rejected", code: "SHIPMENT_STILL_BOOKED", reason: "a live shipment depends on these units" };
    }
    if ((this.held.get(c.sagaId) ?? 0) === 0) {
      return { kind: "rejected", code: "NOTHING_HELD", reason: "no units are held for this order" };
    }
    this.held.set(c.sagaId, 0);
    return { kind: "accepted", effectId: this.stores.inventory.write(c, "compensated", nowMs, "released the held units"), duplicate: false };
  }

  // --- payments ------------------------------------------------------------

  payments(c: Command, nowMs: number): Outcome {
    const state = this.holds.get(c.sagaId) ?? "none";
    if (c.step === "authorize_payment") {
      this.holds.set(c.sagaId, "held");
      return { kind: "accepted", effectId: this.stores.payments.write(c, "applied", nowMs, `held ${c.amountMinor} minor units`), duplicate: false };
    }
    if (c.step === "capture_payment") {
      if (state === "voided") {
        return { kind: "rejected", code: "AUTHORIZATION_VOIDED", reason: "the hold was released" };
      }
      if (state === "none") {
        return { kind: "rejected", code: "NO_AUTHORIZATION", reason: "there is no hold to capture" };
      }
      this.holds.set(c.sagaId, "captured");
      return { kind: "accepted", effectId: this.stores.payments.write(c, "applied", nowMs, `captured ${c.amountMinor} minor units`), duplicate: false };
    }
    // void_authorization
    if (state === "captured") {
      return { kind: "rejected", code: "CANNOT_VOID_CAPTURED", reason: "the funds have settled" };
    }
    if (state === "none") {
      return { kind: "rejected", code: "NO_AUTHORIZATION", reason: "there is no hold to void" };
    }
    this.holds.set(c.sagaId, "voided");
    return { kind: "accepted", effectId: this.stores.payments.write(c, "compensated", nowMs, "released the hold"), duplicate: false };
  }

  // --- fulfilment ----------------------------------------------------------

  fulfilment(c: Command, nowMs: number): Outcome {
    const state = this.bookings.get(c.sagaId) ?? "none";
    if (c.direction === "forward") {
      if (state === "cancelled") {
        return { kind: "rejected", code: "CANCELLED_BEFORE_BOOKING", reason: "the order was cancelled before the carrier answered" };
      }
      this.bookings.set(c.sagaId, "requested");
      const token = `cb-${c.sagaId}-${c.attempt}`;
      this.callbackTokens.set(c.sagaId, token);
      return { kind: "pending", callbackToken: token };
    }
    if (state === "booked") {
      this.bookings.set(c.sagaId, "cancelled");
      return { kind: "accepted", effectId: this.stores.fulfilment.write(c, "compensated", nowMs, "cancelled the carrier booking"), duplicate: false };
    }
    // Nothing has been booked yet, so there is nothing to undo. The
    // participant remembers the refusal so that a carrier answer arriving
    // afterwards cannot create the booking the saga has already given up on.
    this.bookings.set(c.sagaId, "cancelled");
    return { kind: "accepted", effectId: "fulfilment-preemptive", duplicate: false };
  }

  /**
   * The carrier answers. This is the delayed callback, and it is the one
   * message in the system that can arrive after the saga stopped waiting.
   */
  deliverBooking(c: Command, token: string, nowMs: number): Outcome {
    const replayed = this.stores.fulfilment.replay(c, this.dedupe);
    if (replayed !== null) return { kind: "accepted", effectId: replayed, duplicate: true };
    const expected = this.callbackTokens.get(c.sagaId);
    if (expected !== token) {
      return { kind: "rejected", code: "STALE_CALLBACK", reason: "the carrier answered a request that is no longer outstanding" };
    }
    if ((this.bookings.get(c.sagaId) ?? "none") === "cancelled") {
      return { kind: "rejected", code: "CANCELLED_BEFORE_BOOKING", reason: "the order was cancelled before the carrier answered" };
    }
    this.bookings.set(c.sagaId, "booked");
    return { kind: "accepted", effectId: this.stores.fulfilment.write(c, "applied", nowMs, "carrier confirmed the booking"), duplicate: false };
  }

  // --- ledger --------------------------------------------------------------

  ledgerService(c: Command, nowMs: number): Outcome {
    if (c.direction === "compensate") {
      return { kind: "rejected", code: "NO_COMPENSATION_DEFINED", reason: "the ledger does not delete entries" };
    }
    return { kind: "accepted", effectId: this.stores.ledger.write(c, "applied", nowMs, `posted ${c.amountMinor} minor units`), duplicate: false };
  }

  // --- notifications -------------------------------------------------------

  notifications(c: Command, nowMs: number): Outcome {
    if (c.direction === "compensate") {
      return { kind: "rejected", code: "NO_COMPENSATION_DEFINED", reason: "a sent email cannot be unsent" };
    }
    return { kind: "accepted", effectId: this.stores.notifications.write(c, "applied", nowMs, "sent the confirmation"), duplicate: false };
  }
}
