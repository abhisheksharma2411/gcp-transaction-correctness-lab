# ADR-003: The failure matrix is scored by a party that never ran the saga

**Status:** accepted
**Date:** 2026-10-09

## Context

The module's headline artifact is a failure matrix: inject a fault at every
point of every step, drive the saga to quiescence, and report the outcome.

The easy way to produce that table is to read the saga's final state. It is one
field, it is already there, and it is what an operator would look at.

It is also the orchestrator marking its own homework. If the orchestrator has a
bug — if it records a compensation it never sent, or forgets one it should have
sent — the bug is in both the behaviour and the score, and the table reports
success. This failure mode has appeared in five consecutive modules in this
programme under a different name: the checker shares arithmetic with the thing
it checks.

## Decision

Every row is scored twice.

1. The saga's own account of itself: its final state, mapped to one of
   `COMPLETED`, `COMPENSATED`, `MANUAL` or `PENDING`.
2. A verdict computed by `src/audit.ts` from the five participants' effect
   ledgers, with no helper shared with the orchestrator and no access to the
   saga record.

`reconcile` compares them. A disagreement is reported as a defect in the
orchestrator.

## What makes the second path independent

- The auditor never reads a `SagaRecord`. A test asserts that recomputing the
  verdict from the ledgers alone reproduces it exactly.
- It does not re-derive command ids. The orchestrator mints a string, the
  participant stores the string it received, and the auditor counts rows.
- It matches a compensation record back to the step it undoes through the
  definition, not through the orchestrator's key format.
- The mutation `orchestrator-forgets-compensation` makes the saga record a
  compensation it never sent. The saga's own history is internally consistent
  and says `COMPENSATED`. The auditor says `UNRESOLVED`, and the disagreement is
  the finding.

## What it is still not

Both the orchestrator and the auditor read the participants' records. The
orchestrator calls `statusOf` when an outcome is unknown or a compensation is
refused; the auditor reads the same rows. If a participant wrote a record for
something it did not do, both would believe it.

The independence is between *the saga's claim* and *the services' records*, and
no further. `docs/MODEL.md` states this.

## The alternative

Scoring from the saga state alone is simpler and about forty lines shorter. It
would have produced the same table for every row that currently passes — which
is precisely the problem, because it would also have produced the same table for
the row where the saga lies.

## Consequences

- The matrix has a column that can say "no", and in the shipped run it says yes
  thirty-nine times. That number means something it would not otherwise mean.
- Two of the eight negative controls are detectable only through the auditor.
- A real deployment would have to build this: a reconciliation job that reads
  participants' records and compares them with the saga store. That is work, and
  the article says so rather than implying the orchestrator is enough.
