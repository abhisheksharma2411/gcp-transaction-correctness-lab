# ADR-003 — The hash chain covers the content, not the recorded time

**Status:** accepted
**Date:** 2026-10-09

## Context

Each journal carries a `ContentHash` over itself and its postings, and a
`ChainHash` over that content hash and the previous link. The chain is what
detects an edit that leaves the ledger balanced — mutation `M6` raises both
sides of a journal by the same amount, and every balance check in the report is
satisfied by the result.

The commit timestamp is the one field the chain cannot cover.

`PENDING_COMMIT_TIMESTAMP` resolves at commit, which is after the transaction
body has run. The body is where the hash is computed. The documentation is also
explicit that after calling the function, "the table and any derived index is
unreadable to any future SQL statements in the transaction", so there is no
reading it back and no second write within the same transaction.

## Decision

`ContentHash` covers the journal id, ledger, business reference, effective
date, description, reversal link, foreign-exchange note and every posting.
It does not cover `RecordedAt`.

## Alternatives considered

**Write the hash in a second transaction, after the commit timestamp exists.**
This covers everything and breaks atomicity: between the two commits there is a
journal with no chain link, and a crash in that window leaves one permanently.
A ledger whose integrity evidence is eventually written is a ledger whose
integrity evidence can be missing.

**Have the caller supply the recorded time and hash that instead.** Then the
recorded time is whatever the caller said, which is exactly the field an
attacker would want to choose. The module does supply the tick in the test
harness, and `docs/MODEL.md` records that as a divergence from the real commit
timestamp.

**Drop the chain and rely on privileges alone.** The privileges are the
primary control, and `M5` shows what happens without them. But privileges are
a statement about who may write, and the chain is a statement about what was
written. A principal with database-level IAM is outside the first and inside
the second.

## Consequences

**An edit to `RecordedAt` alone is not detected by the chain.** It would be
detected by Admin Activity audit logs if it required a schema or IAM change,
and by Data Access audit logs if those are enabled — which, for every service
except BigQuery, they are not by default. The honest statement is that the
chain detects what was recorded, and the audit log is what has to detect when.

**The chain is ordered by recorded time.** `Ledger.chainHead()` recomputes
links in `(RecordedAt, JournalId)` order, and `post()` refuses a commit whose
tick is not after the previous one. The tie-break on id exists because commit
timestamps are not unique: "Transactions that write to non-overlapping sets of
fields might have the same timestamp." Two journals touching different accounts
can share one, and without the tie-break the chain would renumber itself
depending on which came back first.

**The chain is a detection mechanism, not a prevention mechanism.** It says
that something changed. It does not say what it was before, it cannot restore
it, and anyone able to rewrite every subsequent link can rewrite the chain.
Treating it as tamper-evidence rather than tamper-proofing is the only claim
this design supports.
