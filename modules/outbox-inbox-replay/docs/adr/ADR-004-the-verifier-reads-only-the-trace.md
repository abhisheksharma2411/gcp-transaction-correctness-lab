# ADR-004: The lineage verifier reads only the trace

**Status:** accepted
**Date:** 2026-10-09

## Context

`verifyLineage` could read the stores directly. It has the source service, the
broker and both consumers in the same process; checking that every committed
order has an event would be a loop over two maps.

It would also be a check that could never run anywhere else.

## Decision

The verifier takes a trace and a list of known events. Nothing else. Every
component appends to the trace as it goes, and the verifier decides from those
records alone whether the chain from business change to consumer effect is
intact.

## Consequences

- **A mechanism that works but leaves no record is invisible to the audit.**
  This is a real limitation, not a theoretical one, and test `V08` pins it: run
  the verifier against an empty trace and it reports phantom events for every
  real event, because from its position nothing was ever committed. The fix is
  not to weaken the verifier. It is to write the record.
- The same checks run against a trace assembled from Cloud Logging entries, a
  BigQuery table of delivery records, or a Dataflow job's output, because none
  of them needs the objects. That portability is the point and it is untested:
  no trace from any real system has been put through this.
- `V02` exists because `V01` is worthless without it. A verifier that reports
  zero findings against an empty run has reported nothing, so the standard run
  is separately asserted to contain commits, publishes, deliveries, effects,
  dead letters and a replay.
- Ten finding codes, each provoked by a named control, each control required to
  produce its codes and no others. The control designed to be too blunt is
  required to be rejected as too blunt.

## Rejected alternative

Reading the stores and the trace, and reporting a finding when they disagree.
That is a stronger check of this implementation and a weaker artifact: it would
make the verifier a test of this module rather than a tool that could be
pointed at something else.
