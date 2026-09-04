# ADR-002: OUTCOME_UNKNOWN is a first-class durable state

- Status: Accepted
- Date: 2026-09-03
- Article: 01

## Context

A timeout on a provider call carries no information about whether the charge
was applied. Most codebases collapse this into an error, which is a lie the
rest of the system then acts on.

## Options considered

1. Treat a timeout as failure and let the caller retry.
2. Treat a timeout as success and reconcile later.
3. Record `OUTCOME_UNKNOWN` and resolve it by asking the provider.

## Decision

Option 3.

## Why this option

Option 1 double-charges whenever the effect actually landed. Option 2 credits
money that may never have moved, which is worse: it is a silent accounting
error rather than a visible duplicate.

Two properties follow from the decision:

- An `OUTCOME_UNKNOWN` operation stores **no response snapshot**. A snapshot is
  an answer, and there is no answer yet. A later duplicate receives `202` and
  the same unknown state, never a fabricated result.
- `expires_at` stays NULL until the operation is terminal. Spanner's row
  deletion policy does not delete rows whose timestamp column is NULL, so an
  unresolved operation cannot be garbage-collected while the question is open.
  `tests/spanner-emulator.test.ts` S3 checks this against the real engine.

## Application responsibilities that remain

Reconciliation must have a bounded budget. When the provider has no record of
the key after that budget, the operation moves to `MANUAL_REVIEW` rather than
being guessed into a terminal state. An open financial question stays visible.

## Consequences

The API has a third response class - accepted, declined, and not yet known -
and callers must handle it. This is the honest shape of the problem.

## Conditions that would change the decision

If the provider offered a strictly synchronous, transactional commit protocol
with the caller, the unknown state would be unnecessary. No card provider does.
