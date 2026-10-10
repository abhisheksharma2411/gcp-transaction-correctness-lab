# ADR-002: The lateness window is set from the correction deadline, not from latency

- Status: accepted
- Date: 2026-10-09

## Context

A streaming pipeline has an allowed-lateness setting. Beam's default windowing
"does not allow late data" at all; `withAllowedLateness` is how you change
that, and the value is usually chosen by whoever is tuning the pipeline, on
latency and cost grounds.

A payment network has a correction deadline. Nacha requires a reversal to reach
the receiving institution "within 5 banking days following the Settlement Date
of the Erroneous Entry". That number is chosen by a rules committee and has
nothing to do with anyone's pipeline.

Nothing connects the two. They are set by different people in different
meetings, and the pipeline's number is almost always the smaller one.

## Options considered

1. **Tune lateness for latency and cost**, and accept that some late records
   are dropped. Dataflow documents that completeness cannot be guaranteed
   anyway.
2. **Window by the correction record's own timestamp**, so a correction is
   never late by construction.
3. **Window by the corrected transaction's event time**, and require the
   lateness window to be at least the correction deadline.

## Decision

Option 3. The generator stamps a correction with the event time of the record
it corrects, and `allowedLatenessMs` is treated as a business parameter whose
floor is `correctionWindowMs`.

## Why

Option 2 is tempting and is the quiet default: a correction published today has
today's timestamp, so it is timely, and nothing is dropped. The cost is that
the correction then lands in today's reconciliation rather than in the day it
belongs to, so yesterday's reported position stays wrong and today's is wrong
by the same amount in the other direction. Both days balance. Nobody notices.

Option 1 is defensible for analytics and indefensible for money, and the
measured difference is in `results/report.md`: with a six-hour window against a
five-day deadline, 27 of 910 deliveries are dropped, the accepted effect count
falls from 806 to 779, and the case-state summary is identical to the correct
run. The ledger balances either way.

## Cost

A seven-day lateness window means a seven-day window state in a streaming
pipeline, which is expensive in Streaming Engine and is exactly the cost
pressure that produces a six-hour setting. This ADR does not make that cost go
away; it says where the number comes from, so that lowering it is a decision
somebody takes rather than a default somebody inherits.

Where the cost is genuinely unaffordable, the correction path should not be the
streaming path at all: corrections are low-volume and late by nature, and a
scheduled pass over the raw objects reconstructs the same answer. That is what
the recovery experiment demonstrates.

## Conditions that would change this

A platform whose only correction mechanism is a new, independent transaction —
no amendment of a prior one — does not need this. No payment network read for
this article works that way.
