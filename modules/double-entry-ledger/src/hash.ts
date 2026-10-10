// Deterministic content hashing.
//
// Canonical means the hash is a function of meaning, not of key order or of
// how a JSON serializer felt that day. bigint has no JSON representation, so
// it is written as a decimal string with a type tag — otherwise a BigInt and
// the string that looks like it would hash the same.

import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return `big:${value.toString()}`;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`refusing to hash a non-integer number: ${value}`);
    }
    return `num:${value}`;
  }
  if (typeof value === "string") return `str:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (Array.isArray(value)) {
    // Order is meaning in a list.
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    // Order is noise in an object.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  throw new Error(`cannot hash ${typeof value}`);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
}

/** Chain one content hash onto the previous link. The genesis link is the
 *  ledger id, so two ledgers never share a prefix. */
export function chain(previous: string, contentHash: string): string {
  return createHash("sha256").update(`${previous}|${contentHash}`).digest("hex").slice(0, 32);
}

export function genesisOf(ledgerId: string): string {
  return digest({ genesis: ledgerId });
}

/** What a journal's content hash covers.
 *
 * Note what is absent: the recorded time. The body that computes this hash
 * runs before the commit timestamp exists, so a hash covering it could not be
 * written in the same transaction as the postings. ADR-003 records the
 * trade-off and what it leaves unprotected.
 */
export type HashableJournal = {
  readonly journalId: string;
  readonly ledgerId: string;
  readonly businessRef: string;
  readonly effectiveAt: string;
  readonly description: string;
  readonly reversesJournalId: string | null;
  readonly fxNote: unknown;
  readonly postings: readonly {
    readonly postingId: string;
    readonly lineNumber: number;
    readonly accountId: string;
    readonly direction: string;
    readonly amount: { readonly currency: string; readonly minor: bigint };
    readonly memo: string;
  }[];
};

export function contentHashOf(journal: HashableJournal): string {
  return digest({
    journalId: journal.journalId,
    ledgerId: journal.ledgerId,
    businessRef: journal.businessRef,
    effectiveAt: journal.effectiveAt,
    description: journal.description,
    reversesJournalId: journal.reversesJournalId,
    fxNote: journal.fxNote ?? null,
    postings: journal.postings.map((p) => ({
      postingId: p.postingId,
      lineNumber: p.lineNumber,
      accountId: p.accountId,
      direction: p.direction,
      currency: p.amount.currency,
      minor: p.amount.minor,
      memo: p.memo,
    })),
  });
}
