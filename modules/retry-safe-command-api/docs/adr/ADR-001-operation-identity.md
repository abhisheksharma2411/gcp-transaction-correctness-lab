# ADR-001: The caller supplies a stable operation identity

- Status: Accepted
- Date: 2026-09-03
- Article: 01

## Context

A payment command can arrive many times: an impatient user, an SDK retry
policy, a task queue redelivery, an operator replay. The service must decide
whether two arrivals are the same business intent.

## Requirements and invariants

For one logical business operation, every legitimate retry converges on one
durable outcome, and every externally visible monetary side effect is either
prevented from duplicating or detected and reconciled.

## Options considered

1. Server-generated identity, deduplicated by request body hash alone.
2. Caller-supplied `operationId`, with a request fingerprint for conflict
   detection.
3. Provider-side idempotency key only.

## Decision

Option 2. The caller supplies `operationId`; the service derives the request
fingerprint and the provider key from it.

## Why this option

Option 1 cannot distinguish "the same charge retried" from "a second,
genuinely intended charge of the same amount", which is a real scenario. Option
3 makes correctness a property of the provider's contract, and those contracts
differ - see `docs/provider-contracts.md`.

The provider key is *derived* from the operation identity rather than being the
operation id itself, so the caller's identifier does not leak verbatim into a
third party, and the service can rotate the derivation without asking callers
to change.

## Managed-service guarantees used

Spanner read-write transactions with serializable isolation, giving
external consistency, and commit-time enforcement of UNIQUE indexes.

## Application responsibilities that remain

Callers must persist the operation id *before* the first call and reuse it on
every retry. A caller that mints a new id per attempt defeats this layer
entirely; `effect_claims` is the backstop for that case, and the
`caller mints a new operation id on every retry` row of the failure-injection
matrix measures it.

## Consequences

The API contract now includes an identity requirement, which is a real burden
on integrators and must be documented prominently.

## Cost and operational impact

One extra row per operation, plus its indexes. Negligible next to the cost of
a duplicate charge.

## Security impact

Operation ids are caller-controlled, so they are treated as untrusted input:
length-bounded, and never interpolated into a query. They are not used as the
provider key directly.

## Conditions that would change the decision

If the system only ever handled naturally idempotent state transitions with no
external side effect, the operation ledger would be unnecessary overhead.
