# ADR-002: The pivot is a declared field, not a property discovered at runtime

**Status:** accepted
**Date:** 2026-10-09

## Context

Every saga has a point after which going back is no longer the plan. The
literature calls it the pivot. The question is where that fact lives.

Two places were considered. It can be derived — a step is the pivot if none of
the steps after it declares a compensation — or it can be declared, as a field
on one step, and checked.

## Decision

`pivot: true` is a field on exactly one step in `src/saga.ts`. Three static
checks run on every build:

- exactly one step carries it;
- no step after it declares a compensation;
- no step marked irreversible sits before it.

Each check is run against a definition deliberately broken in the way it claims
to catch.

## Why not derive it

Deriving the pivot makes the most important fact in the design a consequence of
forgetting to write something. A developer who adds a step after the pivot and
does not write a compensation for it has, under the derived rule, silently moved
the pivot. Under the declared rule they have written a definition that fails the
build.

The derived rule also cannot express the case that matters here.
`capture_payment` is technically refundable: a compensation for it could be
written. This design decided not to write one, because a refund is a separate
business process with its own evidence and its own disputes, and Articles 14 and
21 own it. "We could undo this and have decided not to" is a statement about the
business, and a field is the right place for it.

## What the checks cannot tell you

Nothing verifies that the pivot is in a sensible position. A definition that
captures money first and reserves stock afterwards passes all seven static
checks. The checks establish that the definition is well formed; whether it is a
good idea is a judgement, and `docs/MODEL.md` says so.

## Consequences

- Moving the pivot is a visible edit to one line, reviewable as such.
- The generated documentation and both generated diagrams derive the pivot from
  the same field, so the picture cannot show it in a different place from the
  table.
- A step added after the pivot has to be retryable. The definition will not
  accept a compensation for it, which is the constraint being enforced rather
  than a limitation.

## Conditions that would change this

If a saga genuinely had more than one point of no return — several independent
commitments that cannot be undone — a single boolean would stop being enough,
and the field would have to become an ordering over commitment points.
