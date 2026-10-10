# ADR-001: The terminal check runs before the version check

**Status:** accepted
**Date:** 2026-10-09

## Context

`apply` runs four checks before it consults the transition table: terminal,
version, lease, and then the table. The order of the first two is contested,
because a request can fail both at once.

A caller reads a payout at version 3, takes a while, and sends a command. By
the time it arrives the payout has settled and is at version 5. Both answers
are available:

- `VERSION_CONFLICT` — "you are out of date; re-read and decide again"
- `TERMINAL` — "this payout is finished and does not reopen"

Both are true. They lead to different behaviour in the caller.

## Decision

Report `TERMINAL`.

## Why

`VERSION_CONFLICT` is an invitation. Its implied next step is to re-read and
retry, and a well-written client will do exactly that — and will keep doing it,
because re-reading a settled payout produces a settled payout and the command
is still refused. The caller is told to try again forever by a system that
knows the answer will never change.

`TERMINAL` carries strictly more information. It says not only that this
attempt failed but that no attempt will succeed. A caller that receives it can
stop, and stopping is the correct behaviour.

The general rule the two cases share: **when two refusals are both true, report
the one that is permanent.** A transient refusal invites a retry; a permanent
refusal ends the loop. Reporting the transient one when the permanent one is
available turns a decided question into a loop.

## Alternatives

**Version first.** Defensible on the grounds that the concurrency check is
cheaper and more general, and that a caller holding a stale version genuinely
does not know what it is talking about. Rejected because the cost falls on the
case that matters: a client polling a settled payout forever is a real
operational failure, and a client that re-reads a payout it is already allowed
to see loses nothing by being told the truth one round-trip sooner.

**Report both.** Rejected because a refusal with two reason codes is a refusal
nobody branches on correctly.

## Cost

A caller cannot distinguish "finished before I read it" from "finished after I
read it" without reading the history. The history is right there and records
exactly when it finished, so the cost is one extra read in a case that is
already unusual.

## Evidence

`tests/machine.test.ts` has `terminal is reported even when the request is also
stale`, which fails if the order is swapped. The `no-terminal-check` negative
control confirms the terminal check is the thing doing the refusing, rather
than some other check happening to catch it.
