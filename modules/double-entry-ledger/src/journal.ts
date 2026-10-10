// Journal validation, as a pure function.
//
// Nothing here reads a clock or a store. It takes the command, the accounts it
// names and the open-period state, and returns either the postings that would
// be written or the reason the journal is refused. That purity is not
// decoration: Spanner "might execute a transaction's operations multiple times
// internally", so anything inside a read-write transaction body has to produce
// the same answer every time it runs.

import { digest } from "./hash.ts";
import { exponentOf, isKnownCurrency, signedMinor } from "./money.ts";
import type {
  Account,
  JournalCommand,
  Minor,
  Posting,
  Rejection,
} from "./types.ts";

export type ValidationInput = {
  readonly command: JournalCommand;
  /** Every account the command names, by id. Missing means unknown. */
  readonly accounts: ReadonlyMap<string, Account>;
  /** Business references already accepted in this ledger. */
  readonly usedBusinessRefs: ReadonlySet<string>;
  /** Effective dates on or before this are in a closed period. ISO date or
   *  null when nothing is closed. */
  readonly closedThrough: string | null;
  /** Accounts designated as the modelled foreign-exchange bridge. A journal
   *  may cross currencies only by passing through a pair of these. */
  readonly bridgeAccountIds: ReadonlySet<string>;
};

export type ValidationResult =
  | { readonly ok: true; readonly postings: readonly Posting[]; readonly journalId: string }
  | { readonly ok: false; readonly rejection: Rejection };

function reject(code: Rejection["code"], detail: string): ValidationResult {
  return { ok: false, rejection: { code, detail } };
}

/**
 * The journal id is derived from the command, not generated.
 *
 * This is the single most important line in the module. If the id came from a
 * UUID generator called inside the transaction body, a Spanner retry would
 * mint a second id for the same intent and the duplicate would be invisible to
 * the primary key. Deriving it from (ledger, business reference) means a
 * second execution of the same body writes the same row.
 */
export function deriveJournalId(ledgerId: string, businessRef: string): string {
  return `jnl_${digest({ ledgerId, businessRef })}`;
}

export function derivePostingId(journalId: string, lineNumber: number): string {
  return `pst_${journalId.slice(4, 20)}_${String(lineNumber).padStart(4, "0")}`;
}

/** Totals per currency, debits positive and credits negative. */
export function netByCurrency(
  lines: readonly { direction: "DEBIT" | "CREDIT"; amount: { currency: string; minor: Minor } }[],
): Map<string, Minor> {
  const net = new Map<string, Minor>();
  for (const line of lines) {
    const prior = net.get(line.amount.currency) ?? 0n;
    net.set(line.amount.currency, prior + signedMinor(line.direction, line.amount));
  }
  return net;
}

export function validate(input: ValidationInput): ValidationResult {
  const { command, accounts, usedBusinessRefs, closedThrough, bridgeAccountIds } = input;

  if (command.lines.length === 0) {
    return reject("EMPTY_JOURNAL", "a journal with no postings records nothing");
  }
  if (command.lines.length === 1) {
    return reject("UNBALANCED", "a single posting cannot balance against anything");
  }
  if (usedBusinessRefs.has(command.businessRef)) {
    return reject(
      "DUPLICATE_BUSINESS_REF",
      `${command.businessRef} has already been posted in ${command.ledgerId}`,
    );
  }
  if (closedThrough !== null && command.effectiveAt <= closedThrough) {
    return reject(
      "PERIOD_CLOSED",
      `effective ${command.effectiveAt} falls in a period closed through ${closedThrough}`,
    );
  }

  for (const line of command.lines) {
    const account = accounts.get(line.accountId);
    if (account === undefined) {
      return reject("UNKNOWN_ACCOUNT", `no account ${line.accountId}`);
    }
    if (account.ledgerId !== command.ledgerId) {
      return reject(
        "FOREIGN_LEDGER",
        `${line.accountId} belongs to ${account.ledgerId}, not ${command.ledgerId}`,
      );
    }
    if (account.closedEffectiveAt !== null && command.effectiveAt >= account.closedEffectiveAt) {
      return reject("ACCOUNT_CLOSED", `${line.accountId} closed ${account.closedEffectiveAt}`);
    }
    if (!isKnownCurrency(line.amount.currency)) {
      return reject("CURRENCY_MISMATCH", `unknown currency ${line.amount.currency}`);
    }
    if (account.currency !== line.amount.currency) {
      return reject(
        "CURRENCY_MISMATCH",
        `${line.accountId} holds ${account.currency}; posting is ${line.amount.currency}`,
      );
    }
    if (line.amount.minor <= 0n) {
      // Direction carries the sign. A negative debit is a credit wearing a
      // disguise, and it defeats every report that groups by direction.
      return reject(
        "ZERO_AMOUNT",
        `line on ${line.accountId} is ${line.amount.minor}; use the opposite direction instead`,
      );
    }
    exponentOf(line.amount.currency);
  }

  const net = netByCurrency(command.lines);
  const currencies = [...net.keys()].sort();

  if (currencies.length > 1) {
    const touchesBridge = command.lines.some((l) => bridgeAccountIds.has(l.accountId));
    if (!touchesBridge || command.fxNote === undefined || command.fxNote === null) {
      return reject(
        "CROSS_CURRENCY_WITHOUT_BRIDGE",
        `journal spans ${currencies.join(", ")} without a bridge posting and a recorded rate`,
      );
    }
  }

  for (const currency of currencies) {
    const residual = net.get(currency) ?? 0n;
    if (residual !== 0n) {
      return reject(
        "UNBALANCED",
        `${currency} debits minus credits is ${residual} minor units, not 0`,
      );
    }
  }

  const journalId = deriveJournalId(command.ledgerId, command.businessRef);
  const postings: Posting[] = command.lines.map((line, index) => ({
    postingId: derivePostingId(journalId, index + 1),
    journalId,
    ledgerId: command.ledgerId,
    lineNumber: index + 1,
    accountId: line.accountId,
    direction: line.direction,
    amount: line.amount,
    memo: line.memo,
  }));

  return { ok: true, postings, journalId };
}
