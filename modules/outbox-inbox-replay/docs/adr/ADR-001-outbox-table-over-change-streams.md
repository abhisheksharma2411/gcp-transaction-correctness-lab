# ADR-001: An application outbox table, not a change stream

**Status:** accepted
**Date:** 2026-10-09

## Context

Four ways to get a committed change onto a topic:

1. an application outbox table, drained by a relay;
2. Spanner change streams, read by Dataflow or the API;
3. database CDC through Datastream;
4. publishing after the commit, with no durable record in between.

Option 4 is the one the module exists to argue against, and it is implemented
alongside the others so the argument can be run rather than asserted.

Options 2 and 3 are better than option 1 on the dimension that matters most.
Spanner's documentation states that a change stream record is written
"synchronously in the same transaction as the data change," which is exactly
the atomicity the outbox table is built by hand to obtain — except that nobody
has to remember to write the row. An outbox is "potentially error prone since
the developer might forget to publish the message/event after updating the
database," in the pattern's own words.

## Decision

The module implements the outbox table.

Three reasons, in order of weight.

**The event and the row are different things.** A change record describes what
changed in a table. An event describes what happened in the business. The
module's envelope carries an event type, a schema version, an operation id and
a causation id, none of which exist in a row diff and none of which a consumer
can reconstruct from one. Deriving events from change records means writing the
translation somewhere, and that translation is the outbox row with extra steps.

**Change streams have a retention cliff.** Records are retained between one and
thirty days, and reducing the retention limit makes older change data
"immediately and permanently unavailable to that change stream's readers." The
outbox table's retention is a deletion policy somebody chooses, and the event
log behind the replay tool survives it.

**The comparison needs a baseline nobody has to buy.** An outbox is a table and
a loop. It runs on Cloud SQL, on Spanner, and in this module with no cloud
project at all.

## Consequences

- The relay is at-least-once, by construction and not by accident: it publishes
  and then records that it published, and dying between the two republishes.
  `C04` pins this.
- A developer who writes the business row and forgets the outbox row produces
  exactly the defect the `publish-after-commit` control produces. The verifier
  reports `L01_MISSING_EVENT`, which is the only compensation available.
- Nothing here argues that a change stream is the wrong choice. For replicating
  a table to BigQuery it is plainly the right one, and the module's
  `docs/MODEL.md` does not pretend to have modelled it.

## What would change this decision

A system whose consumers genuinely want row-level changes rather than business
events, or one that already runs Dataflow for other reasons, should start from
change streams and skip the table. The translation cost disappears when there
is nothing to translate.
