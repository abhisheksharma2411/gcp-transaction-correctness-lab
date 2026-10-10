// Four numbers people call "the balance", kept apart.
//
// Only one of them is an accounting figure. The others are operational
// conveniences derived from it, and conflating them is how a customer gets
// told they have money they cannot spend, or cannot spend money they have.

import { signedMinor } from "./money.ts";
import type { Ledger } from "./ledger.ts";
import type { AccountKind, BalanceSet, Minor, Posting } from "./types.ts";

/** Which direction increases this kind of account: its normal balance.
 *  Assets and expenses are debit-normal; liabilities, equity and revenue are
 *  credit-normal. */
export function normalSign(kind: AccountKind): 1n | -1n {
  return kind === "ASSET" || kind === "EXPENSE" ? 1n : -1n;
}

/** Present a signed total the way a statement would: positive when the
 *  account holds what it normally holds. */
export function inNormalDirection(kind: AccountKind, signed: Minor): Minor {
  return signed * normalSign(kind);
}

/** The companion account that holds authorized-but-not-captured amounts for
 *  a settlement account, by naming convention. Returns null when there is
 *  none, in which case pending is zero and available equals current. */
export function pendingCompanionOf(ledger: Ledger, accountId: string): string | null {
  const account = ledger.account(accountId);
  if (account === undefined || account.isPending) return null;
  for (const candidate of ledger.allAccounts()) {
    if (candidate.isPending && candidate.path === `${account.path}/pending`) {
      return candidate.accountId;
    }
  }
  return null;
}

function signedTotal(postings: readonly Posting[]): Minor {
  let total = 0n;
  for (const posting of postings) total += signedMinor(posting.direction, posting.amount);
  return total;
}

/**
 * Compute the balance set for one account as of an effective date.
 *
 * `evidence` carries the posting ids that produced `accounting`. A balance
 * that cannot name its postings is a number, not an account balance.
 */
export function balancesFor(ledger: Ledger, accountId: string, asOf: string): BalanceSet {
  const account = ledger.account(accountId);
  if (account === undefined) throw new Error(`no account ${accountId}`);

  const all = ledger.postingsForAccount(accountId);
  const effective = all.filter((posting) => {
    const journal = ledger.journal(posting.journalId);
    return journal !== null && journal.effectiveAt <= asOf;
  });

  const companionId = pendingCompanionOf(ledger, accountId);
  const pending =
    companionId === null ? 0n : signedTotal(ledger.postingsForAccount(companionId));

  const current = signedTotal(all);

  return {
    accountId,
    currency: account.currency,
    accounting: signedTotal(effective),
    current,
    pending,
    // A hold has not moved any money, so it never touches this account. It
    // sits in the companion, and subtracting the companion is what turns a
    // balance into a spending decision.
    available: current - pending,
    evidence: effective.map((p) => p.postingId).sort(),
  };
}

/** Debits and credits across a whole ledger, per currency. The trial balance:
 *  the oldest invariant in the subject and still the one that catches the most. */
export function trialBalance(ledger: Ledger): ReadonlyMap<string, { debits: Minor; credits: Minor }> {
  const out = new Map<string, { debits: Minor; credits: Minor }>();
  for (const posting of ledger.allPostings()) {
    const entry = out.get(posting.amount.currency) ?? { debits: 0n, credits: 0n };
    if (posting.direction === "DEBIT") entry.debits += posting.amount.minor;
    else entry.credits += posting.amount.minor;
    out.set(posting.amount.currency, entry);
  }
  return out;
}
