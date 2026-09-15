# ADR-003: Fairness needs per-tenant projection, not only a per-tenant ceiling

- Status: Accepted
- Date: 2026-09-14
- Article: 02

## Context

The obvious way to stop one tenant monopolising a shared queue is a ceiling:
no tenant may occupy more than some fraction of queue capacity.

The first version of this controller did exactly that, and negative control N1
showed it was not enough.

## Decision

Project each tenant's wait from **its own** backlog and **its own** share of
the measured drain rate, and keep the ceiling as a secondary bound on queue
occupancy.

## Why this option

With a ceiling alone the failure is indirect and easy to miss. The noisy
tenant fills its allowance entirely legitimately. The *global* queue is now
deep. The global promise check then refuses everyone whose projected wait
exceeds the promise — including the small tenant that is nowhere near its own
limit. The ceiling bounded the flooder without protecting its neighbour.

Measured, at a 3x flood beside a 0.3x neighbour:

| | Neighbour completed |
|---|---:|
| Open loop | 1,182 |
| Ceiling with global FIFO projection | starves (N1) |
| Ceiling with fair-share projection | 3,138 |

Under fair service a tenant waits behind its own backlog, not its neighbour's,
so the projection must be computed that way or the promise is being calculated
for a queue the caller is not actually in.

## Consequences

The controller needs per-tenant queue depth, not just a total. Both mechanisms
are kept: the projection decides admission, the ceiling bounds how much memory
and queue one tenant can consume.

## Conditions that would change the decision

Weighted rather than equal shares, if tenants have contractually different
entitlements. The projection generalises to weights without structural change.
