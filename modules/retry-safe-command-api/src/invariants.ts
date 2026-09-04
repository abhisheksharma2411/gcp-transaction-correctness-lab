import { TABLES, type TransactionalStore } from "./store.ts";
import { providerOperationKey } from "./canonical.ts";
import type { DeterministicProvider } from "./provider.ts";
import { OperationState, type LedgerEntry, type OperationRecord } from "./types.ts";
import type { EffectClaim } from "./payment-service.ts";

/**
 * The business-effect invariant harness.
 *
 * Everything here counts *effects*, never API responses. A service that
 * double-charges still returns two syntactically valid success responses, so
 * response-level assertions cannot detect the bug this module exists to
 * catch. The three counts below are collected from three independent places:
 * the provider's own effect log, the service's operation ledger, and the
 * downstream accounting ledger. They must agree.
 */

export interface BusinessReferenceView {
  businessReference: string;
  providerEffects: number;
  succeededOperations: number;
  ledgerPostings: number;
  openOperations: number;
}

export interface EffectAudit {
  providerEffects: number;
  providerAmountMinor: number;
  succeededOperations: number;
  ledgerPostings: number;
  ledgerAmountMinor: number;
  openOperations: number;
  manualReviewOperations: number;
  providerCalls: number;
  providerLookups: number;
  perBusinessReference: BusinessReferenceView[];
  violations: string[];
}

const OPEN_STATES: readonly string[] = [
  OperationState.IN_PROGRESS,
  OperationState.OUTCOME_UNKNOWN,
  OperationState.RECONCILING,
];

export function auditEffects(
  store: TransactionalStore,
  provider: DeterministicProvider,
  options: { allowOpenOperations?: boolean; allowManualReview?: boolean } = {},
): EffectAudit {
  const operations = store.snapshot<OperationRecord>(TABLES.OPERATIONS);
  const claims = store.snapshot<EffectClaim>(TABLES.CLAIMS);
  const ledger = store.snapshot<LedgerEntry>(TABLES.LEDGER);
  const effects = provider.allEffects();
  const violations: string[] = [];

  /**
   * Attribution. An effect must be traceable to something durable. The
   * operation record is the first choice; after retention pruning only the
   * claim survives, and the claim is still a complete answer to "did this
   * order move money". An effect that matches neither is unreconciled money.
   */
  interface Owner {
    businessReference: string;
    state: string;
    amountMinor: number | null;
    source: "operation" | "claim";
  }
  const keyToOwner = new Map<string, Owner>();
  for (const claim of claims) {
    keyToOwner.set(providerOperationKey(claim.operationType, claim.operationId), {
      businessReference: claim.businessReference,
      state: claim.state,
      amountMinor: null,
      source: "claim",
    });
  }
  for (const op of operations) {
    keyToOwner.set(op.providerOperationKey, {
      businessReference: op.businessReference,
      state: op.state,
      amountMinor: op.amountMinor,
      source: "operation",
    });
  }

  const byReference = new Map<string, BusinessReferenceView>();
  const view = (ref: string): BusinessReferenceView => {
    let v = byReference.get(ref);
    if (!v) {
      v = {
        businessReference: ref,
        providerEffects: 0,
        succeededOperations: 0,
        ledgerPostings: 0,
        openOperations: 0,
      };
      byReference.set(ref, v);
    }
    return v;
  };

  for (const effect of effects) {
    const owner = keyToOwner.get(effect.idempotencyKey);
    if (!owner) {
      view("<unattributed>").providerEffects++;
      violations.push(
        `provider effect ${effect.effectRef} cannot be attributed to any operation or claim`,
      );
      continue;
    }
    view(owner.businessReference).providerEffects++;
    if (
      owner.state === OperationState.SUCCEEDED &&
      owner.amountMinor !== null &&
      effect.amountMinor !== owner.amountMinor
    ) {
      violations.push(
        `amount mismatch for ${owner.businessReference}: provider ${effect.amountMinor} vs operation ${owner.amountMinor}`,
      );
    }
  }

  let succeeded = 0;
  let open = 0;
  let manualReview = 0;
  const countedReferences = new Set<string>();
  for (const op of operations) {
    if (op.state === OperationState.SUCCEEDED) {
      succeeded++;
      countedReferences.add(`${op.operationType} ${op.businessReference}`);
      view(op.businessReference).succeededOperations++;
      const owned = provider.effectsForKey(op.providerOperationKey);
      if (owned.length !== 1) {
        violations.push(
          `operation ${op.operationId} is SUCCEEDED but the provider records ${owned.length} effects`,
        );
      }
    } else if (op.state === OperationState.MANUAL_REVIEW) {
      manualReview++;
      view(op.businessReference).openOperations++;
    } else if (OPEN_STATES.includes(op.state)) {
      open++;
      view(op.businessReference).openOperations++;
    }
  }
  // Claims whose operation record was pruned still account for their effect.
  for (const claim of claims) {
    if (claim.state !== OperationState.SUCCEEDED) continue;
    if (countedReferences.has(claim.claimKey)) continue;
    succeeded++;
    view(claim.businessReference).succeededOperations++;
  }

  let ledgerAmount = 0;
  const seenEffectIds = new Set<string>();
  for (const entry of ledger) {
    if (seenEffectIds.has(entry.effectId)) {
      violations.push(`ledger posted effect ${entry.effectId} more than once`);
    }
    seenEffectIds.add(entry.effectId);
    ledgerAmount += entry.amountMinor;
    view(entry.businessReference).ledgerPostings++;
  }

  const providerAmount = effects.reduce((sum, e) => sum + e.amountMinor, 0);

  // Core invariant: for every protected business reference, at most one
  // money-moving effect, and the accounting ledger agrees with the provider.
  for (const v of byReference.values()) {
    if (v.providerEffects > 1) {
      violations.push(
        `business reference ${v.businessReference} has ${v.providerEffects} provider effects`,
      );
    }
    if (v.ledgerPostings > v.providerEffects) {
      violations.push(
        `business reference ${v.businessReference} posted ${v.ledgerPostings} ledger entries for ${v.providerEffects} provider effects`,
      );
    }
  }

  if (succeeded !== effects.length) {
    // Only a violation when nothing is still open: an in-flight or unknown
    // operation legitimately has an effect the service has not yet claimed.
    if (open === 0 && manualReview === 0) {
      violations.push(
        `succeeded operations (${succeeded}) does not equal provider effects (${effects.length})`,
      );
    }
  }

  if (open > 0 && !options.allowOpenOperations) {
    violations.push(`${open} operations are still open at audit time`);
  }
  if (manualReview > 0 && !options.allowManualReview) {
    violations.push(`${manualReview} operations require manual review at audit time`);
  }

  return {
    providerEffects: effects.length,
    providerAmountMinor: providerAmount,
    succeededOperations: succeeded,
    ledgerPostings: ledger.length,
    ledgerAmountMinor: ledgerAmount,
    openOperations: open,
    manualReviewOperations: manualReview,
    providerCalls: provider.callCount,
    providerLookups: provider.lookupCount,
    perBusinessReference: [...byReference.values()].sort((a, b) =>
      a.businessReference.localeCompare(b.businessReference),
    ),
    violations,
  };
}

export function assertNoViolations(audit: EffectAudit): void {
  if (audit.violations.length > 0) {
    throw new Error(`effect invariants violated:\n  - ${audit.violations.join("\n  - ")}`);
  }
}
