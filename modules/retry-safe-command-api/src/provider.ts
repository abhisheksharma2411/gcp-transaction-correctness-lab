/**
 * A deterministic payment-provider simulator.
 *
 * The point of this file is the effect log. It is the authoritative record of
 * how many times money actually moved, and it is maintained by the provider,
 * not by the service under test. Every invariant assertion in this module is
 * made against this log rather than against the API responses the service
 * returned, because a service that double-charges can still return two
 * perfectly well-formed 200s.
 */

export const Fault = {
  NONE: "NONE",
  /** The charge is applied, then the response is lost. The classic bad case. */
  DROP_RESPONSE_AFTER_EFFECT: "DROP_RESPONSE_AFTER_EFFECT",
  /** The request never reached the provider. No effect exists. */
  TIMEOUT_BEFORE_EFFECT: "TIMEOUT_BEFORE_EFFECT",
  /** The provider refused. Definitive: no effect, and retrying will not help. */
  DECLINE: "DECLINE",
  /** Transient server error before any effect. */
  SERVER_ERROR: "SERVER_ERROR",
} as const;
export type Fault = (typeof Fault)[keyof typeof Fault];

export class ProviderTimeoutError extends Error {
  constructor(message = "provider call timed out; outcome unknown") {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderServerError extends Error {
  constructor(message = "provider returned 5xx; outcome unknown") {
    super(message);
    this.name = "ProviderServerError";
  }
}

export interface ProviderEffect {
  effectRef: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  createdAtSeq: number;
}

export interface ProviderResponse {
  outcome: "APPROVED" | "DECLINED";
  effectRef: string | null;
  declineCode: string | null;
  /** True when the provider recognised the idempotency key and replayed. */
  replayed: boolean;
}

export interface ChargeRequest {
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
}

/**
 * Fault plan: a queue of faults consumed per *call attempt*, not per operation.
 * A missing entry means Fault.NONE.
 */
export class DeterministicProvider {
  private effects = new Map<string, ProviderEffect>();
  private declines = new Set<string>();
  private faultPlan: Fault[] = [];
  private seq = 0;
  callCount = 0;
  lookupCount = 0;
  /** Records every call attempt for evidence output. */
  readonly callLog: Array<{ key: string; fault: Fault; result: string }> = [];

  constructor(faultPlan: Fault[] = []) {
    this.faultPlan = [...faultPlan];
  }

  planFaults(faults: Fault[]): void {
    this.faultPlan = [...faults];
  }

  private nextFault(): Fault {
    return this.faultPlan.shift() ?? Fault.NONE;
  }

  /**
   * Charge with provider-side idempotency keyed on idempotencyKey.
   *
   * Mirrors the contract most providers publish: the same key returns the
   * first outcome instead of applying a second effect. This is a modelled
   * contract, not a universal guarantee — see docs/provider-contracts.md.
   */
  async charge(req: ChargeRequest): Promise<ProviderResponse> {
    this.callCount++;
    const fault = this.nextFault();

    const existing = this.effects.get(req.idempotencyKey);
    if (existing) {
      if (existing.amountMinor !== req.amountMinor || existing.currency !== req.currency) {
        this.callLog.push({ key: req.idempotencyKey, fault, result: "KEY_REUSE_MISMATCH" });
        throw new Error("provider rejected idempotency key reuse with different parameters");
      }
      this.callLog.push({ key: req.idempotencyKey, fault, result: "REPLAYED_APPROVED" });
      return { outcome: "APPROVED", effectRef: existing.effectRef, declineCode: null, replayed: true };
    }
    if (this.declines.has(req.idempotencyKey)) {
      this.callLog.push({ key: req.idempotencyKey, fault, result: "REPLAYED_DECLINED" });
      return { outcome: "DECLINED", effectRef: null, declineCode: "card_declined", replayed: true };
    }

    switch (fault) {
      case Fault.TIMEOUT_BEFORE_EFFECT:
        this.callLog.push({ key: req.idempotencyKey, fault, result: "TIMEOUT_NO_EFFECT" });
        throw new ProviderTimeoutError();
      case Fault.SERVER_ERROR:
        this.callLog.push({ key: req.idempotencyKey, fault, result: "SERVER_ERROR_NO_EFFECT" });
        throw new ProviderServerError();
      case Fault.DECLINE: {
        this.declines.add(req.idempotencyKey);
        this.callLog.push({ key: req.idempotencyKey, fault, result: "DECLINED" });
        return { outcome: "DECLINED", effectRef: null, declineCode: "card_declined", replayed: false };
      }
      case Fault.DROP_RESPONSE_AFTER_EFFECT: {
        this.applyEffect(req);
        this.callLog.push({ key: req.idempotencyKey, fault, result: "EFFECT_APPLIED_RESPONSE_LOST" });
        throw new ProviderTimeoutError("response lost after the charge was applied");
      }
      default: {
        const effect = this.applyEffect(req);
        this.callLog.push({ key: req.idempotencyKey, fault, result: "APPROVED" });
        return { outcome: "APPROVED", effectRef: effect.effectRef, declineCode: null, replayed: false };
      }
    }
  }

  private applyEffect(req: ChargeRequest): ProviderEffect {
    const effect: ProviderEffect = {
      effectRef: `pe_${String(++this.seq).padStart(6, "0")}`,
      idempotencyKey: req.idempotencyKey,
      amountMinor: req.amountMinor,
      currency: req.currency,
      createdAtSeq: this.seq,
    };
    this.effects.set(req.idempotencyKey, effect);
    return effect;
  }

  /**
   * The reconciliation path. Asking the provider what it actually did is the
   * only way to resolve an unknown outcome; guessing is how money gets lost.
   */
  async lookup(idempotencyKey: string): Promise<ProviderResponse | null> {
    this.lookupCount++;
    const effect = this.effects.get(idempotencyKey);
    if (effect) {
      return { outcome: "APPROVED", effectRef: effect.effectRef, declineCode: null, replayed: true };
    }
    if (this.declines.has(idempotencyKey)) {
      return { outcome: "DECLINED", effectRef: null, declineCode: "card_declined", replayed: true };
    }
    return null;
  }

  /** Authoritative count of money-moving effects. */
  effectCount(): number {
    return this.effects.size;
  }

  allEffects(): ProviderEffect[] {
    return [...this.effects.values()].sort((a, b) => a.createdAtSeq - b.createdAtSeq);
  }

  effectsForKey(idempotencyKey: string): ProviderEffect[] {
    const e = this.effects.get(idempotencyKey);
    return e ? [e] : [];
  }
}

/**
 * A provider that does NOT honour idempotency keys. Used to demonstrate that
 * the caller-side design still bounds the damage, and that provider
 * idempotency is an assumption to verify rather than a universal property.
 */
export class NonIdempotentProvider extends DeterministicProvider {
  async charge(req: ChargeRequest): Promise<ProviderResponse> {
    // Bypass key lookup entirely: every call applies a new effect.
    return super.charge({ ...req, idempotencyKey: `${req.idempotencyKey}#${Math.random()}` });
  }
}
