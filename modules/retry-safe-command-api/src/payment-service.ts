import { requestFingerprint, providerOperationKey, effectId } from "./canonical.ts";
import {
  TABLES,
  UniqueViolationError,
  type Transaction,
  type TransactionalStore,
} from "./store.ts";
import {
  DeterministicProvider,
  ProviderServerError,
  ProviderTimeoutError,
} from "./provider.ts";
import {
  OperationState,
  ResultStatus,
  isTerminal,
  type CommandResult,
  type OperationRecord,
  type OutboxRecord,
  type PaymentCommand,
} from "./types.ts";
import { type Clock, DAY_MS, MINUTE_MS } from "./clock.ts";

/**
 * A long-lived claim on a protected business reference.
 *
 * This row outlives the operation record on purpose. The operation record
 * holds the response snapshot and the request fingerprint and can be pruned
 * on a short cycle; the claim holds only the question "did this order already
 * move money, and under which effect?" and is kept for as long as the money
 * is disputable. Without the asymmetry, a retry arriving after the
 * idempotency record is pruned looks like a brand-new request.
 */
export interface EffectClaim {
  claimKey: string;
  operationType: string;
  businessReference: string;
  operationId: string;
  state: string;
  providerEffectId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ServiceConfig {
  /** How long one worker may hold an operation before another may take over. */
  leaseMs: number;
  /** Retention of the operation identity, including its response snapshot. */
  identityRetentionMs: number;
  /** Reconciliation attempts before an unknown outcome escalates to a human. */
  maxReconcileAttempts: number;
  workerId: string;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  leaseMs: 2 * MINUTE_MS,
  identityRetentionMs: DAY_MS,
  maxReconcileAttempts: 3,
  workerId: "worker-1",
};

type ClaimDecision =
  | { kind: "EXECUTE"; record: OperationRecord }
  | { kind: "RESULT"; result: CommandResult };

export interface ReconcileTask {
  operationId: string;
  notBeforeMs: number;
}

export class PaymentService {
  private store: TransactionalStore;
  private provider: DeterministicProvider;
  private clock: Clock;
  private config: ServiceConfig;
  /**
   * Stands in for a Cloud Tasks queue. Tasks are named after the operation so
   * enqueueing the same reconciliation twice is a no-op, which is the same
   * property Cloud Tasks gives you through task-name deduplication.
   */
  readonly reconcileQueue = new Map<string, ReconcileTask>();

  constructor(
    store: TransactionalStore,
    provider: DeterministicProvider,
    clock: Clock,
    config: Partial<ServiceConfig> = {},
  ) {
    this.store = store;
    this.provider = provider;
    this.clock = clock;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  withWorker(workerId: string): PaymentService {
    return new PaymentService(this.store, this.provider, this.clock, {
      ...this.config,
      workerId,
    });
  }

  /** The single entry point. Safe to call any number of times per command. */
  async execute(command: PaymentCommand): Promise<CommandResult> {
    const fingerprint = requestFingerprint(command);
    let decision: ClaimDecision;
    try {
      decision = await this.claim(command, fingerprint);
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        // The claims table already prevents this. Reaching here means a code
        // path forgot to take a claim, so fail closed rather than charge.
        return {
          status: ResultStatus.BUSINESS_REFERENCE_CONFLICT,
          operationId: command.operationId,
          state: OperationState.FAILED_FINAL,
          httpStatus: 409,
          replayed: false,
          failureCode: "business_reference_already_claimed",
        };
      }
      throw err;
    }
    if (decision.kind === "RESULT") return decision.result;
    return this.callProviderAndSettle(decision.record);
  }

  /**
   * Transaction 1. Decides whether this caller is allowed to touch the
   * provider at all. Every branch that returns a result here has performed
   * exactly zero external side effects.
   */
  private claim(command: PaymentCommand, fingerprint: string): Promise<ClaimDecision> {
    const now = this.clock.nowMs();
    const claimKey = `${command.operationType} ${command.businessReference}`;

    return this.store.runTransaction<ClaimDecision>((tx: Transaction) => {
      const existing = tx.read<OperationRecord>(TABLES.OPERATIONS, command.operationId);

      if (!existing) {
        const claim = tx.read<EffectClaim>(TABLES.CLAIMS, claimKey);
        if (claim && claim.state !== OperationState.FAILED_FINAL) {
          if (claim.operationId === command.operationId) {
            // Same operation id, but its record was pruned by retention.
            // The claim survived, so we can answer without charging again.
            return {
              kind: "RESULT",
              result: {
                status: ResultStatus.IDENTITY_EXPIRED,
                operationId: command.operationId,
                state: claim.state as OperationState,
                httpStatus: 409,
                providerEffectId: claim.providerEffectId,
                replayed: true,
                failureCode: "operation_identity_expired_effect_exists",
              },
            };
          }
          // A different operation id already owns this order.
          return {
            kind: "RESULT",
            result: {
              status: ResultStatus.BUSINESS_REFERENCE_CONFLICT,
              operationId: command.operationId,
              state: claim.state as OperationState,
              httpStatus: 409,
              providerEffectId: claim.providerEffectId,
              replayed: false,
              failureCode: "business_reference_already_claimed",
            },
          };
        }

        const record: OperationRecord = {
          operationId: command.operationId,
          operationType: command.operationType,
          businessReference: command.businessReference,
          requestFingerprint: fingerprint,
          amountMinor: command.amountMinor,
          currency: command.currency.toUpperCase(),
          state: OperationState.IN_PROGRESS,
          providerOperationKey: providerOperationKey(command.operationType, command.operationId),
          providerEffectId: null,
          failureCode: null,
          responseSnapshot: null,
          attemptCount: 1,
          leaseOwner: this.config.workerId,
          leaseExpiresAtMs: now + this.config.leaseMs,
          createdAtMs: now,
          updatedAtMs: now,
          expiresAtMs: now + this.config.identityRetentionMs,
          reconcileAttempts: 0,
        };
        tx.write(TABLES.OPERATIONS, record.operationId, record);
        tx.write(TABLES.CLAIMS, claimKey, {
          claimKey,
          operationType: command.operationType,
          businessReference: command.businessReference,
          operationId: command.operationId,
          state: OperationState.IN_PROGRESS,
          providerEffectId: null,
          createdAtMs: now,
          updatedAtMs: now,
        } satisfies EffectClaim);
        return { kind: "EXECUTE", record };
      }

      // The operation id is known. Decide without calling anyone.
      if (existing.requestFingerprint !== fingerprint) {
        return {
          kind: "RESULT",
          result: {
            status: ResultStatus.PARAMETER_MISMATCH,
            operationId: existing.operationId,
            state: existing.state,
            httpStatus: 422,
            replayed: false,
            failureCode: "operation_id_reused_with_different_parameters",
          },
        };
      }

      if (isTerminal(existing.state) && existing.responseSnapshot) {
        return {
          kind: "RESULT",
          result: { ...existing.responseSnapshot, replayed: true },
        };
      }

      if (
        existing.state === OperationState.OUTCOME_UNKNOWN ||
        existing.state === OperationState.RECONCILING
      ) {
        this.enqueueReconcile(existing.operationId, now);
        return {
          kind: "RESULT",
          result: {
            status: ResultStatus.PENDING_UNKNOWN,
            operationId: existing.operationId,
            state: existing.state,
            httpStatus: 202,
            replayed: true,
            failureCode: null,
          },
        };
      }

      if (existing.state === OperationState.MANUAL_REVIEW) {
        return {
          kind: "RESULT",
          result: {
            status: ResultStatus.NEEDS_MANUAL_REVIEW,
            operationId: existing.operationId,
            state: existing.state,
            httpStatus: 409,
            replayed: true,
            failureCode: "unknown_outcome_escalated",
          },
        };
      }

      // IN_PROGRESS. Either someone is working on it, or their lease lapsed.
      const leaseValid =
        existing.leaseExpiresAtMs !== null && existing.leaseExpiresAtMs > now;
      if (leaseValid) {
        return {
          kind: "RESULT",
          result: {
            status: ResultStatus.IN_PROGRESS_ELSEWHERE,
            operationId: existing.operationId,
            state: existing.state,
            httpStatus: 409,
            replayed: false,
            failureCode: "operation_in_progress",
          },
        };
      }

      const takenOver: OperationRecord = {
        ...existing,
        attemptCount: existing.attemptCount + 1,
        leaseOwner: this.config.workerId,
        leaseExpiresAtMs: now + this.config.leaseMs,
        updatedAtMs: now,
      };
      tx.write(TABLES.OPERATIONS, takenOver.operationId, takenOver);
      return { kind: "EXECUTE", record: takenOver };
    });
  }

  /**
   * The provider call sits deliberately outside any transaction. A database
   * transaction cannot make a third-party HTTP call atomic; pretending
   * otherwise is what produces charges with no record of them.
   */
  private async callProviderAndSettle(record: OperationRecord): Promise<CommandResult> {
    try {
      const response = await this.provider.charge({
        idempotencyKey: record.providerOperationKey,
        amountMinor: record.amountMinor,
        currency: record.currency,
      });
      return await this.settle(record.operationId, {
        kind: response.outcome === "APPROVED" ? "APPROVED" : "DECLINED",
        effectRef: response.effectRef,
        declineCode: response.declineCode,
      });
    } catch (err) {
      if (err instanceof ProviderTimeoutError || err instanceof ProviderServerError) {
        return this.markUnknown(record.operationId);
      }
      throw err;
    }
  }

  /**
   * Transaction 2. The state change and the event that announces it are
   * written together, so there is no window in which the operation succeeded
   * but nothing downstream will ever hear about it.
   */
  private settle(
    operationId: string,
    outcome: { kind: "APPROVED" | "DECLINED"; effectRef: string | null; declineCode: string | null },
  ): Promise<CommandResult> {
    const now = this.clock.nowMs();
    return this.store.runTransaction<CommandResult>((tx) => {
      const op = tx.read<OperationRecord>(TABLES.OPERATIONS, operationId);
      if (!op) throw new Error(`operation disappeared during settle: ${operationId}`);

      if (isTerminal(op.state) && op.responseSnapshot) {
        return { ...op.responseSnapshot, replayed: true };
      }

      const claimKey = `${op.operationType} ${op.businessReference}`;
      const claim = tx.read<EffectClaim>(TABLES.CLAIMS, claimKey);

      if (outcome.kind === "APPROVED") {
        const eid = effectId(op.operationType, op.operationId);
        const result: CommandResult = {
          status: ResultStatus.ACCEPTED,
          operationId,
          state: OperationState.SUCCEEDED,
          httpStatus: 201,
          providerEffectId: outcome.effectRef,
          replayed: false,
          failureCode: null,
        };
        tx.write(TABLES.OPERATIONS, operationId, {
          ...op,
          state: OperationState.SUCCEEDED,
          providerEffectId: outcome.effectRef,
          responseSnapshot: result,
          leaseOwner: null,
          leaseExpiresAtMs: null,
          updatedAtMs: now,
        } satisfies OperationRecord);
        if (claim) {
          tx.write(TABLES.CLAIMS, claimKey, {
            ...claim,
            state: OperationState.SUCCEEDED,
            providerEffectId: eid,
            updatedAtMs: now,
          } satisfies EffectClaim);
        }
        this.appendOutbox(tx, op, "payment.succeeded", eid, {
          operationId,
          businessReference: op.businessReference,
          amountMinor: op.amountMinor,
          currency: op.currency,
          providerEffectRef: outcome.effectRef,
        });
        return result;
      }

      const result: CommandResult = {
        status: ResultStatus.DECLINED,
        operationId,
        state: OperationState.FAILED_FINAL,
        httpStatus: 402,
        providerEffectId: null,
        replayed: false,
        failureCode: outcome.declineCode,
      };
      tx.write(TABLES.OPERATIONS, operationId, {
        ...op,
        state: OperationState.FAILED_FINAL,
        failureCode: outcome.declineCode,
        responseSnapshot: result,
        leaseOwner: null,
        leaseExpiresAtMs: null,
        updatedAtMs: now,
      } satisfies OperationRecord);
      if (claim) {
        // No money moved, so the order is free to be attempted again under a
        // new operation id.
        tx.write(TABLES.CLAIMS, claimKey, {
          ...claim,
          state: OperationState.FAILED_FINAL,
          updatedAtMs: now,
        } satisfies EffectClaim);
      }
      this.appendOutbox(tx, op, "payment.failed", effectId(op.operationType, op.operationId), {
        operationId,
        businessReference: op.businessReference,
        declineCode: outcome.declineCode,
      });
      return result;
    });
  }

  private markUnknown(operationId: string): Promise<CommandResult> {
    const now = this.clock.nowMs();
    return this.store.runTransaction<CommandResult>((tx) => {
      const op = tx.read<OperationRecord>(TABLES.OPERATIONS, operationId);
      if (!op) throw new Error(`operation disappeared: ${operationId}`);
      if (isTerminal(op.state) && op.responseSnapshot) {
        return { ...op.responseSnapshot, replayed: true };
      }
      const result: CommandResult = {
        status: ResultStatus.PENDING_UNKNOWN,
        operationId,
        state: OperationState.OUTCOME_UNKNOWN,
        httpStatus: 202,
        providerEffectId: null,
        replayed: false,
        failureCode: null,
      };
      tx.write(TABLES.OPERATIONS, operationId, {
        ...op,
        state: OperationState.OUTCOME_UNKNOWN,
        // No response snapshot: an unknown outcome is not an answer, and a
        // later retry must not be handed this as if it were final.
        leaseOwner: null,
        leaseExpiresAtMs: null,
        updatedAtMs: now,
      } satisfies OperationRecord);
      this.enqueueReconcile(operationId, now);
      return result;
    });
  }

  private appendOutbox(
    tx: Transaction,
    op: OperationRecord,
    eventType: string,
    eid: string,
    payload: Record<string, unknown>,
  ): void {
    const outboxId = `${op.operationId}:${eventType}`;
    const row: OutboxRecord = {
      outboxId,
      operationId: op.operationId,
      eventType,
      effectId: eid,
      payload,
      createdAtMs: this.clock.nowMs(),
      publishedAtMs: null,
    };
    tx.write(TABLES.OUTBOX, outboxId, row);
  }

  /** Deterministic task name means enqueueing twice enqueues once. */
  private enqueueReconcile(operationId: string, nowMs: number): void {
    if (!this.reconcileQueue.has(operationId)) {
      this.reconcileQueue.set(operationId, { operationId, notBeforeMs: nowMs });
    }
  }

  /**
   * Resolve one unknown outcome by asking the provider what it actually did.
   * Safe to call repeatedly: a terminal operation is left alone.
   */
  async reconcile(operationId: string): Promise<CommandResult> {
    const now = this.clock.nowMs();
    const start = await this.store.runTransaction<OperationRecord | CommandResult | null>((tx) => {
      const op = tx.read<OperationRecord>(TABLES.OPERATIONS, operationId);
      if (!op) return null;
      if (isTerminal(op.state) && op.responseSnapshot) {
        return { ...op.responseSnapshot, replayed: true };
      }
      if (op.state !== OperationState.OUTCOME_UNKNOWN && op.state !== OperationState.RECONCILING) {
        return null;
      }
      const next: OperationRecord = {
        ...op,
        state: OperationState.RECONCILING,
        reconcileAttempts: op.reconcileAttempts + 1,
        updatedAtMs: now,
      };
      tx.write(TABLES.OPERATIONS, operationId, next);
      return next;
    });

    if (start === null) {
      return {
        status: ResultStatus.PENDING_UNKNOWN,
        operationId,
        state: OperationState.OUTCOME_UNKNOWN,
        httpStatus: 202,
        replayed: true,
      };
    }
    if (!("providerOperationKey" in start)) return start as CommandResult;

    const op = start as OperationRecord;
    const found = await this.provider.lookup(op.providerOperationKey);

    if (found && found.outcome === "APPROVED") {
      const result = await this.settleFromReconcile(operationId, {
        kind: "APPROVED",
        effectRef: found.effectRef,
        declineCode: null,
      });
      this.reconcileQueue.delete(operationId);
      return result;
    }
    if (found && found.outcome === "DECLINED") {
      const result = await this.settleFromReconcile(operationId, {
        kind: "DECLINED",
        effectRef: null,
        declineCode: found.declineCode,
      });
      this.reconcileQueue.delete(operationId);
      return result;
    }

    // The provider has no record of the key. That is evidence, not proof:
    // it may still be converging. Retry within budget, then escalate.
    return this.store.runTransaction<CommandResult>((tx) => {
      const current = tx.read<OperationRecord>(TABLES.OPERATIONS, operationId);
      if (!current) throw new Error(`operation disappeared: ${operationId}`);
      if (isTerminal(current.state) && current.responseSnapshot) {
        return { ...current.responseSnapshot, replayed: true };
      }
      if (current.reconcileAttempts >= this.config.maxReconcileAttempts) {
        const result: CommandResult = {
          status: ResultStatus.NEEDS_MANUAL_REVIEW,
          operationId,
          state: OperationState.MANUAL_REVIEW,
          httpStatus: 409,
          replayed: false,
          failureCode: "provider_has_no_record_after_budget",
        };
        tx.write(TABLES.OPERATIONS, operationId, {
          ...current,
          state: OperationState.MANUAL_REVIEW,
          updatedAtMs: this.clock.nowMs(),
        } satisfies OperationRecord);
        this.reconcileQueue.delete(operationId);
        return result;
      }
      tx.write(TABLES.OPERATIONS, operationId, {
        ...current,
        state: OperationState.OUTCOME_UNKNOWN,
        updatedAtMs: this.clock.nowMs(),
      } satisfies OperationRecord);
      return {
        status: ResultStatus.PENDING_UNKNOWN,
        operationId,
        state: OperationState.OUTCOME_UNKNOWN,
        httpStatus: 202,
        replayed: false,
      };
    });
  }

  private settleFromReconcile(
    operationId: string,
    outcome: { kind: "APPROVED" | "DECLINED"; effectRef: string | null; declineCode: string | null },
  ): Promise<CommandResult> {
    return this.settle(operationId, outcome);
  }

  /** Drain the reconciliation queue. Models a Cloud Tasks worker. */
  async runReconciliation(): Promise<CommandResult[]> {
    const out: CommandResult[] = [];
    for (const task of [...this.reconcileQueue.values()]) {
      if (task.notBeforeMs > this.clock.nowMs()) continue;
      out.push(await this.reconcile(task.operationId));
    }
    return out;
  }

  /**
   * Retention sweep. Models a Spanner row-deletion policy on the operation
   * table. Claims are intentionally untouched.
   */
  async pruneExpiredIdentities(): Promise<number> {
    const now = this.clock.nowMs();
    return this.store.runTransaction<number>((tx) => {
      const rows = tx.scan<OperationRecord>(TABLES.OPERATIONS);
      let pruned = 0;
      for (const row of rows) {
        if (row.expiresAtMs <= now && isTerminal(row.state)) {
          tx.delete(TABLES.OPERATIONS, row.operationId);
          pruned++;
        }
      }
      return pruned;
    });
  }

  getOperation(operationId: string): Promise<OperationRecord | null> {
    return this.store.runTransaction((tx) =>
      tx.read<OperationRecord>(TABLES.OPERATIONS, operationId),
    );
  }
}
