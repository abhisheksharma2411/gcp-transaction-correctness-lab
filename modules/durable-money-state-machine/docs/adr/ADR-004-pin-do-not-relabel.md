# ADR-004: In-flight entities are pinned to the version that started them

**Status:** accepted
**Date:** 2026-10-09

## Context

The machine changed. Version 1 auto-approved every amount and treated an
indeterminate provider lookup as a decline. Version 2 routes large amounts to a
human and treats an indeterminate lookup as something a human must resolve.

Entities are mid-flight when the change deploys. Something has to decide what
happens to them.

## Decision

Entities carry the specification version they are running under. An entity in
flight keeps running under the version it started on until it reaches a terminal
state. A migration is attempted only for entities where no decision has been
taken yet, and is refused outright where version 1 made a decision version 2
would not have made.

Three answers, all reportable by a dry run:

- `MIGRATED` — nothing has been decided; version 2 may take it from here.
- `PINNED` — in flight, or finished. It runs out under the old version.
- `BLOCKED` — version 1 took a decision version 2 forbids. Migrating would make
  the history claim a review that never happened.

## Why

This is the shape both managed platforms converge on, from different directions.

Workflows pins: "Updating a workflow does not affect in-progress executions.
Only future executions of the workflow will use the updated configuration."

Temporal replays, and therefore constrains: "The Workflow Definition can change
in very limited ways once there is a Workflow Execution depending on it," and a
command that does not match the recorded event history produces a
non-determinism error.

Different mechanisms, same consequence for anybody writing business logic: more
than one version of the process is alive at once. Pinning does not remove the
problem. It moves it from the engine into your table, where it is at least
visible and queryable.

## The thing this refuses to do

Relabel. A payout version 1 auto-approved at nine hundred thousand minor units
is not a payout version 2 approved; version 2 would have sent it to a human.
Changing its `specVersion` would make the history assert a decision nobody took,
and the history is the only evidence the system has.

Refusing is not free — somebody has to look at the blocked list. That is the
correct cost, because the blocked list is exactly the set of entities where the
old machine and the new one disagree, and that set deserves attention rather
than a default.

## Alternatives

**Migrate everything.** Fast and wrong for the blocked set.

**Drain before deploying.** Correct, and unavailable for a process that can wait
six hours on a provider — the drain never finishes.

**Keep only one version and change behaviour behind a flag.** Equivalent to
pinning with worse ergonomics: the flag has to be stored on the entity anyway,
and then it is a version number with a vaguer name.

## Cost

Both versions' code must stay deployed until the last pinned entity finishes.
There is no bound on that in general; here, the six-hour callback deadline and
the terminal-state invariant together give one. A machine with no deadline on
its waits would have no bound, which is another reason ADR-003 exists.

## Evidence

`tests/migrate.test.ts`, especially `a decision version 2 would not have taken
blocks the migration` and `the migration never rewrites a history record`.
Scenarios S20 and S21.
