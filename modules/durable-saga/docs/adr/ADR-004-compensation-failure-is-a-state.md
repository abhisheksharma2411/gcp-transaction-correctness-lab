# ADR-004: A compensation that will not succeed is a state, not a retry loop

**Status:** accepted
**Date:** 2026-10-09

## Context

Compensations fail. The payment service is down, the carrier refuses the
cancellation, inventory will not release units a live shipment depends on.

The common answer is to retry until it works, on the theory that a compensation
is the system's own business logic and must eventually succeed. The saga
literature does not agree: Garcia-Molina and Salem raise the case directly and
observe that a transaction which fails for a deterministic reason will fail the
same way when it is run again.

## Decision

Each compensation gets three attempts. When they are exhausted the saga moves
to `COMPENSATION_FAILED`, which is a declared state owned by payments
operations. The chain stops where it stopped; compensations that already have a
record are not re-run.

An operator has two commands. `operator_retried` resumes the chain from where
it stopped. `operator_closed` moves the saga to `CLOSED_MANUALLY`, a terminal
state that leaves the remaining effects visible rather than claiming they are
gone.

## Why not retry forever

Because the common cause of a compensation failing is not a transient outage.
It is that the compensation is invalid: the payment service refuses to void an
authorization it has already captured, and it will refuse the next ten thousand
times too. A saga that retries that forever produces a queue nobody is watching
and a business process nobody owns.

The module ships the alternative as the mutation `no-attempt-cap`. With it
applied, the probe never leaves `COMPENSATING` and the outcome column reads
`PENDING` — a saga that is neither done nor visibly broken, which is the state
this decision exists to make impossible.

## Why the operator can close rather than only retry

Because some positions cannot be reached automatically and pretending otherwise
is worse than admitting it. A saga closed by an operator is the one case where
the auditor's verdict is allowed to disagree with the saga's own state: the
ledgers say `UNRESOLVED`, the saga says `CLOSED_MANUALLY`, and the two together
mean "a person looked at this and accepted the position". That is more honest
than a terminal state claiming the effects were undone.

## Consequences

- Both states a person owns name the owner in the definition, and a static
  check fails the build if a state that only an operator can leave does not.
- The number three is invented. `docs/MODEL.md` says so.
- An operator retry resets the compensation attempt counters and nothing else.
  The forward cursor is untouched, so a repair resumes rather than replays;
  there is a test for that, and the participants' de-duplication is the second
  line of defence rather than the first.

## Conditions that would change this

If every compensation in a saga were provably idempotent and provably eventually
satisfiable — no business refusals, only outages — an unbounded retry with
backoff would be defensible. No saga that moves money has that property, because
the pivot makes at least one compensation permanently invalid.
