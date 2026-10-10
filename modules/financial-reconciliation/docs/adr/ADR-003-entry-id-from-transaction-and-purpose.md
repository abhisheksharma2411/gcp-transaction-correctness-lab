# ADR-003: An entry id is derived from the transaction and the purpose

- Status: accepted
- Date: 2026-10-09

## Context

Replay has to be safe. Not "we do not replay" — every system replays, usually
during a recovery, and usually with the derived stores empty because that is
what is being recovered.

The question is what refuses the second posting. Candidates: the assertion
de-duplication set, the reconciliation case, or the ledger itself.

## Options considered

1. **A sequence-allocated entry id**, with a unique constraint on
   `(transaction, purpose)` beside it.
2. **An entry id derived from the evidence** that produced the entry.
3. **An entry id derived from the transaction and the purpose**, with the
   evidence id carried on the entry as a provenance field.

## Decision

Option 3.

## Why

Option 2 reads better and is wrong in a specific case. Two sources announce one
capture; the evidence differs because the source is part of the assertion; the
entry ids therefore differ; the capture posts twice. The corpus case is R05 and
the unit test is "two sources announcing one capture collide on the entry id".

Option 1 works and puts the guard in a constraint rather than in the id, which
means the application has to catch a constraint violation and decide what it
means. The decision is the same every time, so encoding it in the id is one
fewer place to get it wrong.

Adjustments are the exception that proves the rule: a transaction can
legitimately be corrected more than once, so adjustment entries take the
evidence id as an extra scope. That asymmetry is deliberate and is the reason
`make` has a case for each.

## Consequences

- `rebuildDerived()` followed by `replay()` is safe, and R10 demonstrates it
  with every cache above the ledger emptied.
- Removing the guard (`noEntryDedup`) doubles the accepted effects on a rebuild
  and the ledger still balances, which is the sharpest single demonstration in
  the module that balance is not a duplicate detector.
- The purpose vocabulary becomes part of the contract. Adding a new purpose
  that should collide with an existing one is a breaking change and nothing in
  the build detects it.

## What this does not give you

Spanner "might execute a transaction's operations multiple times internally",
and side effects from a retried body "might occur multiple times". A
deterministic entry id makes the *insert* idempotent; it does nothing for an
external call made inside the same transaction body. That boundary belongs to
Article 12 and is not re-derived here.
