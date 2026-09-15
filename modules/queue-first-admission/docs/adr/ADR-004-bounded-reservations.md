# ADR-004: A reservation backlog must be bounded

- Status: Accepted
- Date: 2026-09-14
- Article: 02

## Context

When work can be completed asynchronously, refusing it is wasteful. Offering a
reservation is better: the caller gets an answer now and the work is completed
when capacity exists.

## Decision

Bound outstanding reservations. Past the bound, refuse even deferrable work.

## Why this option

The first version of this controller deferred *any* deferrable arrival that
would otherwise have been refused. Experiment E9 showed what that produces:
essentially every arrival accepted, a backlog far beyond what could be
completed, and thousands of reservations expiring unfulfilled.

That is the unlimited-backlog anti-pattern wearing a different hat. The caller
is told "accepted" and discovers much later that it was not. A refusal the
caller can act on immediately is a better answer than an acceptance the system
has already calculated it cannot honour.

With the bound in place, the same experiment completes slightly more work than
open loop (13,987 against 13,622) with **zero** expiries — and the price is
visible in the latency column, where deferred work shows a p99 above ten
seconds. That is the honest trade: deferral buys completion at the cost of
time, and only for work whose caller is not waiting.

## Consequences

`maxReservations` is a capacity decision driven by how long a reservation is
allowed to live and how fast the system drains, not a round number. Reservation
TTL and the bound must be chosen together.

## Conditions that would change the decision

If reservations were persisted and the business genuinely accepted multi-hour
fulfilment, the bound would rise — but it would still exist.
