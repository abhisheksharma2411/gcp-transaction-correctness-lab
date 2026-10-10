# ADR-003: The conformance matrix is data, not assertions

**Status:** accepted
**Date:** 2026-10-09

## Context

The obvious way to write this suite is as twenty test functions. It would be
shorter, it would read naturally, and it would be a test suite for one
TypeScript implementation.

The article's stated contribution is "a language-neutral idempotency contract
and conformance matrix that can be implemented in Java, TypeScript, Go, or
another supported language." A suite of TypeScript assertions does not satisfy
that, however well written.

## Decision

Every case is a JSON-serialisable document: a list of declarative steps
(`submit`, `inbox`, `webhook`, `enqueue`, `advance`, `evict`, `resolve`) and a
set of expectations (`effects`, `decisions`, `caughtBy`, `rejectedSteps`). An
interpreter of roughly 120 lines executes them.

`scripts/export-matrix.ts` writes `conformance-matrix.json`, and `make verify`
fails if that file has drifted from the source. Test `M2` asserts the matrix
round-trips through `JSON.stringify` — if that ever stops holding, the matrix
has quietly become code again.

Porting the contract to another language therefore means porting the
interpreter, not the cases.

## Consequences

- The step vocabulary is deliberately small and will not express every
  interesting scenario. That is the cost. A case that cannot be expressed as
  data does not go in the matrix; it goes in `tests/` as an ordinary test, and
  several have (`tests/layers.test.ts`, `tests/boundaries.test.ts`).
- Every case carries a `covers` field naming the required behaviour it
  demonstrates, so the matrix can be audited against the article's claims
  without reading the implementation.
- The matrix passed 20/20 on its first run, which is exactly what you would
  expect when the same author writes both sides and proves nothing. The four
  mutations in `MUTATIONS` exist for that reason: each removes one layer, and
  each must turn specific named cases red (`N1`). A mutation that reddens the
  whole matrix is also rejected (`N2`), because a blunt control cannot show
  which case covers which layer.
