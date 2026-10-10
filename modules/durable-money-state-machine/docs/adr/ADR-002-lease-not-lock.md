# ADR-002: A lease in a row, not a lock in a transaction

**Status:** accepted
**Date:** 2026-10-09

## Context

A payout in `SUBMITTED` waits on a provider for up to six hours. A worker that
picks it up and dies must not leave it waiting forever, and a second worker
must not pick it up while the first is still working.

The version check does not solve this. It answers "did anyone move this since I
read it?", which a stopped process satisfies perfectly: nothing moved, so
nothing is suspicious, and the payout sits in `SUBMITTED` until somebody looks
at a dashboard.

## Decision

Store a lease on the entity — an owner identifier and an expiry instant — and
require a worker to hold an unexpired lease before it may advance a process
already in flight. External arrivals (provider callbacks, operator decisions)
do not take a lease, because they are not resuming anything.

A periodic sweep reports two different kinds of stuck, separately:

- `LEASE_EXPIRED` — a worker took this and did not come back. Another worker may
  claim it. A machine died; the business process is fine.
- `WAITING_TOO_LONG` — the entity has sat in a waiting state past its own
  deadline. No worker is at fault and claiming it changes nothing.

## Why not a database lock

A lock belongs to a transaction, and the transaction is the wrong lifetime.
Spanner's documentation is explicit about what happens to a transaction that
waits: "If the client remains inactive for long periods of time, Spanner might
release the transaction's locks and abort the transaction." It also recommends
minimising how long a transaction is active, because "long-held locks can lead
to deadlocks and transaction aborts."

A six-hour wait on a provider cannot be held inside a transaction. The lease is
a row precisely so that it can outlive every transaction that touches it.

## Why not a timeout alone

Because a timeout does not stop the work. Cloud Tasks documents its dispatch
deadline as cancelling the request: "If the worker does not respond by this
deadline then the request is cancelled and the attempt is marked as a
DEADLINE_EXCEEDED failure." And then: "when the request is cancelled, Cloud
Tasks will stop listening for the response, but whether the worker stops
processing depends on the worker. For example, if the worker is stuck, it may
not react to cancelled requests."

So a deadline tells you that nobody answered. The lease tells you whether
anybody is still trying. They are different facts and a recovery procedure
needs both.

## Alternatives

**A heartbeat column.** Equivalent in effect and worse in shape: it records
liveness without recording who is responsible, so a recovering worker cannot
tell whether it is taking over from somebody or racing them.

**No lease; rely on the deadline to re-drive everything.** Simpler, and it
works for processes whose steps are cheap to repeat. It fails for the step that
moves money, which is the one step in this machine that must not be repeated.

**A distributed lock service.** Correct and heavier. A lease column in the
entity's own row is one write in a transaction you are already doing.

## Cost

- The lease must be claimed and acted on atomically, and this module cannot
  demonstrate that it does, because it is single-threaded. See `docs/MODEL.md`.
- The TTL is a judgement. Too short and a healthy worker loses its claim
  mid-step; too long and a dead worker's entity waits that long to be noticed.
- Clock skew between workers makes expiry fuzzy, and the module does not model
  it.

## Evidence

`tests/lease.test.ts`, in particular `the version check cannot see a worker that
stopped` and `the sweep separates a dead worker from a slow provider`. Scenario
S17 is the end-to-end version. The `no-lease-check` negative control confirms
the lease is what refuses a second worker.
