# ADR-002: The idempotency record expires; the business constraint does not

**Status:** accepted
**Date:** 2026-10-09

## Context

Every de-duplication mechanism in this article's subject area has a finite
window, and the windows are vendor-specific. Cloud Tasks documents that a task
name is not immediately reusable and that it "can take up to 24 hours (or 9 days
if the task's queue was created using a queue.yaml or queue.xml)". An
idempotency table has whatever TTL someone chose. A provider's key retention is
whatever its contract says.

So the interesting question is not *whether* a key expires but what the system
does on the first arrival after it has.

## Decision

Two separate structures with two separate lifetimes:

- **The operation record** is subject to the retention window and is physically
  evicted by `evictExpired`. After eviction, a duplicate is indistinguishable
  from a first request, and `decide` correctly returns `FIRST`.
- **The business-reference index** is never evicted. It records that a
  particular real-world thing — an order, an invoice — has been acted on, and
  that fact does not stop being true because a TTL elapsed.

`IdempotencyStore.evictExpired` deliberately leaves the second intact, and a
test asserts it (`L2`).

## Consequences

- An idempotency key is a de-duplication *convenience* with an expiry date. A
  uniqueness constraint is a statement about the world. Conflating them is how a
  replay during a disaster-recovery drill becomes a second charge.
- The post-eviction scenario in `results/report.md` is the demonstration: the
  contract stops catching anything, and `business-uniqueness` and
  `effect-ledger` catch one arrival each.
- The retention window is a knob with a real cost on both sides. Too short and
  legitimate late retries re-run; too long and the table grows without bound.
  This module takes it as a parameter and states no recommended value, because
  the right one depends on how late a client can legitimately retry.
- Nothing here presents Cloud Tasks' 24-hour / 9-day window as universal. It is
  cited as evidence that these windows exist and are finite, which is the only
  claim the article makes about it.
