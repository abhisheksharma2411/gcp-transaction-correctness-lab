# ADR-001: Conflict detection is checked before expiry

**Status:** accepted
**Date:** 2026-10-09

## Context

`decide` has five answers and four checks, and the order of those checks is a
real decision with consequences, not a stylistic one.

The case that forces it: a record exists, it is past its retention window, and
the arriving request has a *different* fingerprint. Two defensible answers:

- **EXPIRED** — the record is no longer authoritative, so treat the arrival as
  new and let the business constraint deal with it.
- **CONFLICT** — the system still has the old request in hand, and it can see
  the new one disagrees.

## Decision

Conflict is checked first. A same-key / different-payload arrival is refused
even past the retention window.

The argument is asymmetric availability of information. While the record is in
hand, the system knows enough to give the strong answer. Once the record is
evicted it will never be able to give that answer again — and eviction is not a
hypothetical, it is the normal end of every record's life.

So: take the strong answer while it is free. The weak answer remains available
afterwards and costs nothing to fall back to.

## Consequences

- A client that reuses a key with a changed payload gets `CONFLICT` rather than
  a silent replay of someone else's result. Replaying here would tell the caller
  their *new* request succeeded, which it did not. Test `D06` pins the ordering.
- Conflict is also checked before `IN_PROGRESS`, for the same reason: a
  conflicting request is wrong whether or not the original has finished
  (test `D07`).
- The negative control `no-fingerprint-check` turns case `C04` red and nothing
  else, which is the evidence that this check is doing work that no other layer
  does.
- An implementation that reverses this ordering still passes nineteen of the
  twenty conformance cases. That is why the case exists.
