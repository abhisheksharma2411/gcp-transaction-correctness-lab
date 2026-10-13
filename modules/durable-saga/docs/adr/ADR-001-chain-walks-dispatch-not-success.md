# ADR-001: The compensation chain walks what was dispatched, not what succeeded

**Status:** accepted
**Date:** 2026-10-09

## Context

When a saga fails before its pivot, something has to decide which compensations
to send. The obvious source is the list of steps that completed: each one
produced a durable effect, so each one needs undoing.

That list is wrong, and the case that proves it is the asynchronous step.
`book_shipment` returns nothing useful — the carrier answers later, over a
callback. A saga that is cancelled while that answer is outstanding has a step
it sent and no idea whether it worked.

## Decision

The saga record carries `dispatched`, a list of every step whose command left
the orchestrator, in order. The compensation chain walks that list in reverse,
skipping only steps that already have a compensation record.

`completed` is still recorded, because the forward path needs it, but nothing
in the compensation path reads it.

## The alternative, and what it costs

The alternative is to compensate only confirmed steps. It is cheaper — the
chain sends fewer commands, and every command it sends is one the participant
can satisfy.

It is also wrong in a way that does not show up in the saga's own records. The
module ships the alternative as the mutation `compensate-only-confirmed`. With
it applied, a cancellation during the carrier wait produces a saga whose record
says `COMPENSATED`, whose own history is internally consistent, and whose
fulfilment service has a live booking against a cancelled order. The orchestrator
cannot see this. The auditor can, because it reads fulfilment's ledger.

The cost of the decision is that the chain sends compensations for steps that
may not have happened. Those commands are refused — `NOTHING_HELD`,
`NO_AUTHORIZATION` — and refusing them is not a failure. When a compensation is
refused, the orchestrator asks the participant what it has recorded; if the
answer is "nothing", the compensation is complete, not failed. That lookup is
the price, and it is one request per unnecessary compensation.

## Consequences

- A participant has to be able to answer "what did you record for this saga and
  this step?". This module gives every participant that method. A real
  participant that cannot answer it forces the saga to guess, which is the
  thing this decision exists to avoid.
- A compensation for a step that never applied must be a no-op at the
  participant rather than an error. `cancel_shipment` against an unbooked order
  records a refusal to book rather than a cancellation, which is also what stops
  the carrier booking it afterwards.
- The chain is longer than it needs to be in the common case.

## Conditions that would change this

If every participant were synchronous and every response were either definitive
or absent with a reliable lookup, the two lists would be identical and the
simpler one would do. The moment one step answers later, they diverge.
