// The invariant checker.
//
// Nine named invariants over a ledger and its projection, each producing a
// row in a machine-readable proof report. Two design choices matter more than
// the checks themselves:
//
//   * every invariant reports the size of the population it examined, and
//   * a report in which any invariant examined an empty population is not a
//     pass.
//
// An invariant that holds vacuously is the most comfortable kind of green
// there is. INV-0 exists to refuse it.

import { chain, contentHashOf, digest, genesisOf } from "./hash.ts";
import { netByCurrency } from "./journal.ts";
import { trialBalance } from "./balances.ts";
import type { Ledger } from "./ledger.ts";
import type { BalanceProjection } from "./projection.ts";
import type { Minor } from "./types.ts";

export type InvariantStatus = "HOLDS" | "VIOLATED" | "VACUOUS";

export type InvariantResult = {
  readonly id: string;
  readonly name: string;
  /** What this check would catch that no other check here would. */
  readonly covers: string;
  readonly status: InvariantStatus;
  /** How many things were examined. Zero is never a pass. */
  readonly population: number;
  readonly violations: readonly string[];
};

export type ProofReport = {
  readonly ledgerId: string;
  readonly asOf: string;
  readonly invariants: readonly InvariantResult[];
  readonly summary: {
    readonly checked: number;
    readonly holds: number;
    readonly violated: number;
    readonly vacuous: number;
    readonly verdict: "PROVEN" | "VIOLATED" | "INCONCLUSIVE";
  };
  /** Hash over the report body, so two runs can be compared without diffing
   *  prose. */
  readonly digest: string;
};

function result(
  id: string,
  name: string,
  covers: string,
  population: number,
  violations: readonly string[],
): InvariantResult {
  const status: InvariantStatus =
    violations.length > 0 ? "VIOLATED" : population === 0 ? "VACUOUS" : "HOLDS";
  return { id, name, covers, status, population, violations: [...violations] };
}

function minorToString(value: Minor): string {
  return value.toString();
}

export function checkLedger(
  ledger: Ledger,
  projection: BalanceProjection,
  asOf: string,
): ProofReport {
  const journals = ledger.allJournals();
  const postings = ledger.allPostings();
  const invariants: InvariantResult[] = [];

  // INV-1 — every accepted journal balances, per currency.
  {
    const violations: string[] = [];
    for (const journal of journals) {
      for (const [currency, residual] of netByCurrency(journal.postings)) {
        if (residual !== 0n) {
          violations.push(
            `${journal.journalId} ${currency} residual ${minorToString(residual)}`,
          );
        }
      }
    }
    invariants.push(
      result(
        "INV-1",
        "journal balanced",
        "a journal whose debits and credits differ was accepted",
        journals.length,
        violations,
      ),
    );
  }

  // INV-2 — the posting log has not been edited.
  {
    const violations: string[] = [];
    let link = genesisOf(ledger.ledgerId);
    for (const journal of journals) {
      const recomputed = contentHashOf(journal);
      if (recomputed !== journal.contentHash) {
        violations.push(`${journal.journalId} content hash does not match its postings`);
      }
      link = chain(link, journal.contentHash);
      if (link !== journal.chainHash) {
        violations.push(`${journal.journalId} breaks the chain at this link`);
      }
    }
    invariants.push(
      result(
        "INV-2",
        "posting log intact",
        "a posting was altered or removed after it was written",
        journals.length,
        violations,
      ),
    );
  }

  // INV-3 — the projection equals the rebuild from postings.
  {
    const rebuilt = ledger.rebuildBalances();
    const violations: string[] = [];
    const accounts = new Set<string>([...rebuilt.keys(), ...projection.snapshot().keys()]);
    for (const accountId of [...accounts].sort()) {
      const authoritative = rebuilt.get(accountId) ?? 0n;
      const projected = projection.balanceOf(accountId);
      if (authoritative !== projected) {
        violations.push(
          `${accountId} postings ${minorToString(authoritative)} projection ${minorToString(projected)}`,
        );
      }
    }
    invariants.push(
      result(
        "INV-3",
        "projection equals rebuild",
        "the cached balance drifted from the postings that determine it",
        accounts.size,
        violations,
      ),
    );
  }

  // INV-4 — no posting without an accepted journal, and no journal without
  // the postings it claims.
  {
    const violations: string[] = [];
    const byJournal = new Map<string, number>();
    for (const posting of postings) {
      byJournal.set(posting.journalId, (byJournal.get(posting.journalId) ?? 0) + 1);
      if (ledger.journal(posting.journalId) === null) {
        violations.push(`${posting.postingId} has no journal ${posting.journalId}`);
      }
    }
    for (const journal of journals) {
      const stored = byJournal.get(journal.journalId) ?? 0;
      if (stored !== journal.postings.length) {
        violations.push(
          `${journal.journalId} claims ${journal.postings.length} postings; ${stored} stored`,
        );
      }
    }
    invariants.push(
      result(
        "INV-4",
        "no orphan postings",
        "a journal and its postings were torn apart, by a partial write or a retention sweep",
        postings.length,
        violations,
      ),
    );
  }

  // INV-5 — a reversal nets its original to zero, account by account.
  {
    const reversals = journals.filter((j) => j.reversesJournalId !== null);
    const violations: string[] = [];
    for (const reversal of reversals) {
      const original = journals.find((j) => j.journalId === reversal.reversesJournalId);
      if (original === undefined) {
        violations.push(`${reversal.journalId} reverses a journal that is not here`);
        continue;
      }
      const net = new Map<string, Minor>();
      for (const posting of [...original.postings, ...reversal.postings]) {
        const key = `${posting.accountId}|${posting.amount.currency}`;
        const sign = posting.direction === "DEBIT" ? 1n : -1n;
        net.set(key, (net.get(key) ?? 0n) + sign * posting.amount.minor);
      }
      for (const [key, value] of net) {
        if (value !== 0n) {
          violations.push(`${reversal.journalId} leaves ${key} at ${minorToString(value)}`);
        }
      }
      if (original.postings.length === 0) {
        violations.push(`${original.journalId} has no postings to reverse`);
      }
    }
    invariants.push(
      result(
        "INV-5",
        "reversal nets to zero",
        "a correction that did not actually undo what it claimed to undo",
        reversals.length,
        violations,
      ),
    );
  }

  // INV-6 — every posting's currency matches its account's.
  {
    const violations: string[] = [];
    for (const posting of postings) {
      const account = ledger.account(posting.accountId);
      if (account === undefined) {
        violations.push(`${posting.postingId} names an account that does not exist`);
        continue;
      }
      if (account.currency !== posting.amount.currency) {
        violations.push(
          `${posting.postingId} is ${posting.amount.currency}; ${account.accountId} holds ${account.currency}`,
        );
      }
    }
    invariants.push(
      result(
        "INV-6",
        "currency consistent",
        "two currencies summed into one account balance",
        postings.length,
        violations,
      ),
    );
  }

  // INV-7 — nothing accepted into a closed period, and recorded time is
  // preserved independently of effective time.
  {
    const closed = ledger.closedPeriodThrough();
    const violations: string[] = [];
    for (const journal of journals) {
      if (closed !== null && journal.effectiveAt <= closed) {
        violations.push(`${journal.journalId} is effective ${journal.effectiveAt}, inside the closed period`);
      }
      if (journal.recordedAt === journal.effectiveAt) {
        violations.push(`${journal.journalId} collapsed recorded time into effective time`);
      }
    }
    invariants.push(
      result(
        "INV-7",
        "period and time separation",
        "a backdated entry that lost its recorded time, or landed in a closed period",
        journals.length,
        violations,
      ),
    );
  }

  // INV-8 — the trial balance: total debits equal total credits, per currency.
  {
    const violations: string[] = [];
    const tb = trialBalance(ledger);
    for (const [currency, { debits, credits }] of [...tb.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (debits !== credits) {
        violations.push(
          `${currency} debits ${minorToString(debits)} credits ${minorToString(credits)}`,
        );
      }
    }
    invariants.push(
      result(
        "INV-8",
        "trial balance",
        "an imbalance spread across several journals that each look fine alone",
        tb.size,
        violations,
      ),
    );
  }

  // INV-9 — one business reference, one journal.
  {
    const seen = new Map<string, string>();
    const violations: string[] = [];
    for (const journal of journals) {
      const prior = seen.get(journal.businessRef);
      if (prior !== undefined) {
        violations.push(`${journal.businessRef} posted as both ${prior} and ${journal.journalId}`);
      }
      seen.set(journal.businessRef, journal.journalId);
    }
    invariants.push(
      result(
        "INV-9",
        "business reference unique",
        "the same real-world event posted twice under two journal ids",
        journals.length,
        violations,
      ),
    );
  }

  const violated = invariants.filter((i) => i.status === "VIOLATED").length;
  const vacuous = invariants.filter((i) => i.status === "VACUOUS").length;
  const holds = invariants.filter((i) => i.status === "HOLDS").length;

  const summary = {
    checked: invariants.length,
    holds,
    violated,
    vacuous,
    verdict:
      violated > 0
        ? ("VIOLATED" as const)
        : vacuous > 0
          ? // INV-0, stated as a rule rather than as a tenth row: a report in
            // which something was proven over nothing is inconclusive, and
            // saying so is the only thing that stops a checker from being
            // reassuring by default.
            ("INCONCLUSIVE" as const)
          : ("PROVEN" as const),
  };

  const body = { ledgerId: ledger.ledgerId, asOf, invariants, summary };
  return { ...body, digest: digest(body) };
}
