// A minimal balanced ledger, used here as an oracle rather than as a design.
//
// Article 14 owns accounting: chart of accounts, posting rules, balance
// reconstruction, period close. This module needs exactly one thing from a
// ledger -- a check that cannot be satisfied by a reconciliation decision that
// is internally incoherent. Every entry sums to zero, so an engine that
// accepts a settlement it cannot account for either fails to post or posts
// something that does not balance, and both are visible.
//
// The ledger also refuses a repeated entry id. That refusal is what makes
// replay safe, and it is the reason `entryId` is derived from the evidence and
// the purpose rather than being allocated by a sequence.

import { entryId } from "./identity.ts";
import type { Account, JournalEntry, Posting } from "./types.ts";

export class LedgerError extends Error {}

export type PostOutcome = "POSTED" | "ALREADY_POSTED";

export function sumPostings(postings: readonly Posting[]): number {
  let total = 0;
  for (const p of postings) total += p.amountMinor;
  return total;
}

export class Ledger {
  private readonly entries = new Map<string, JournalEntry>();
  private readonly order: string[] = [];
  /** Entries refused because their id was already present. */
  duplicateEntries = 0;

  /**
   * Post an entry.
   *
   * @param dedupe when false, the entry-level guard is removed. This exists so
   *   that the negative controls in src/cases.ts can prove the guard is doing
   *   work rather than decorating a path that is already safe.
   */
  post(entry: JournalEntry, dedupe = true): PostOutcome {
    if (entry.postings.length === 0) throw new LedgerError("entry has no postings");
    const total = sumPostings(entry.postings);
    if (total !== 0) {
      throw new LedgerError(
        `entry ${entry.entryId} does not balance: postings sum to ${total}`,
      );
    }
    if (dedupe && this.entries.has(entry.entryId)) {
      this.duplicateEntries += 1;
      return "ALREADY_POSTED";
    }
    // Without the guard the same id overwrites, which is how a replay silently
    // keeps one entry and loses the knowledge that it ran twice. With the
    // guard off we append under a widened key so the double effect is visible.
    const key = this.entries.has(entry.entryId)
      ? `${entry.entryId}#${this.order.length}`
      : entry.entryId;
    this.entries.set(key, entry);
    this.order.push(key);
    return "POSTED";
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  all(): readonly JournalEntry[] {
    return this.order.map((k) => this.entries.get(k)!);
  }

  get count(): number {
    return this.order.length;
  }

  /** Account balances, in minor units, keyed `account|currency`. */
  balances(): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of this.all()) {
      for (const p of e.postings) {
        const k = `${p.account}|${e.currency}`;
        out.set(k, (out.get(k) ?? 0) + p.amountMinor);
      }
    }
    return out;
  }

  /**
   * The invariant: every currency's postings sum to zero across all accounts.
   *
   * This is weaker than a real accounting check and stronger than it looks.
   * It cannot tell you that money went to the right account. It can tell you
   * that the engine never invented or destroyed a unit, which is the failure
   * mode that duplicate and corrected evidence actually produces.
   */
  isBalanced(): boolean {
    const byCurrency = new Map<string, number>();
    for (const e of this.all()) {
      byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + sumPostings(e.postings));
    }
    for (const v of byCurrency.values()) if (v !== 0) return false;
    return true;
  }

  /** Every entry derived from one piece of evidence. The audit path, backwards. */
  entriesForEvidence(evidence: string): readonly JournalEntry[] {
    return this.all().filter((e) => e.evidenceId === evidence);
  }
}

/**
 * Build an entry.
 *
 * The id is derived from the transaction and the purpose, *not* from the
 * evidence. That is a deliberate asymmetry. One transaction has one capture
 * however many sources announce it, so two sources announcing the same capture
 * must collide on the id and be refused. The evidence id still travels on the
 * entry, because the question an auditor asks is "which record made you post
 * this", and the answer has to survive.
 *
 * Adjustments pass `scope` so that several of them can coexist: a transaction
 * may legitimately be corrected more than once, and each correction is its own
 * effect with its own provenance.
 */
function make(
  transactionId: string,
  evidence: string,
  purpose: string,
  occurredAtMs: number,
  currency: string,
  postings: readonly Posting[],
  scope = "",
): JournalEntry {
  return {
    entryId: entryId(transactionId, scope, purpose),
    transactionId,
    evidenceId: evidence,
    purpose,
    occurredAtMs,
    currency,
    postings,
  };
}

/** Funds taken: the merchant is owed, the clearing position rises. */
export function captureEntry(
  transactionId: string, evidence: string, occurredAtMs: number,
  currency: string, grossMinor: number,
): JournalEntry {
  return make(transactionId, evidence, "capture", occurredAtMs, currency, [
    { account: "merchant_receivable", amountMinor: grossMinor },
    { account: "clearing", amountMinor: -grossMinor },
  ]);
}

/** Settlement: net cash arrives, the fee is recognised, the receivable clears. */
export function settlementEntry(
  transactionId: string, evidence: string, occurredAtMs: number,
  currency: string, netMinor: number, feeMinor: number,
): JournalEntry {
  return make(transactionId, evidence, "settlement", occurredAtMs, currency, [
    { account: "settled_cash", amountMinor: netMinor },
    { account: "fee_expense", amountMinor: feeMinor },
    { account: "merchant_receivable", amountMinor: -(netMinor + feeMinor) },
  ]);
}

/** A reversal is a new entry, never an erasure of the capture. */
export function reversalEntry(
  transactionId: string, evidence: string, occurredAtMs: number,
  currency: string, grossMinor: number,
): JournalEntry {
  return make(transactionId, evidence, "reversal", occurredAtMs, currency, [
    { account: "clearing", amountMinor: grossMinor },
    { account: "merchant_receivable", amountMinor: -grossMinor },
  ]);
}

/**
 * An adjustment posted when evidence arrives after the position went final.
 *
 * The original entry is not touched. The delta goes to suspense, where a human
 * has to look at it, which is the honest representation of "we told the
 * business a number and the number has changed".
 */
export function adjustmentEntry(
  transactionId: string, evidence: string, occurredAtMs: number,
  currency: string, deltaMinor: number, account: Account,
): JournalEntry {
  return make(transactionId, evidence, "adjustment", occurredAtMs, currency, [
    { account, amountMinor: deltaMinor },
    { account: "suspense", amountMinor: -deltaMinor },
  ], evidence);
}

/**
 * A settlement whose allocation across transactions is not known.
 *
 * The cash arrived and the fee is real, so both are posted. What is not known
 * is whose receivable it clears, so the offset goes to suspense and a human
 * is told. Posting it to the receivable anyway would balance and would be a
 * guess recorded as a fact.
 */
export function unallocatedSettlementEntry(
  groupId: string, evidence: string, occurredAtMs: number,
  currency: string, netMinor: number, feeMinor: number,
): JournalEntry {
  return make(groupId, evidence, "grouped-settlement", occurredAtMs, currency, [
    { account: "settled_cash", amountMinor: netMinor },
    { account: "fee_expense", amountMinor: feeMinor },
    { account: "suspense", amountMinor: -(netMinor + feeMinor) },
  ], evidence);
}

/** An operator writing a residual out of suspense, with their decision attached. */
export function writeOffEntry(
  transactionId: string, evidence: string, occurredAtMs: number,
  currency: string, amountMinor: number, version: number,
): JournalEntry {
  return make(transactionId, evidence, "write-off", occurredAtMs, currency, [
    { account: "fee_expense", amountMinor: amountMinor },
    { account: "suspense", amountMinor: -amountMinor },
  ], `resolution-${version}`);
}
