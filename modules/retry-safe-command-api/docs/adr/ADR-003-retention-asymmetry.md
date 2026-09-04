# ADR-003: The effect claim outlives the operation record

- Status: Accepted
- Date: 2026-09-03
- Article: 01

## Context

Idempotency records are usually pruned. Stripe documents that keys may be
removed after at least 24 hours and that reuse after pruning produces a new
request. If the service does the same thing, a late retry after the retention
window looks like fresh business intent.

## Decision

Split the state into two tables with different retention:

- `payment_operations`: fingerprint, response snapshot, lease, attempt counts.
  Short retention, enforced by a Spanner row deletion policy on `expires_at`.
- `effect_claims`: keyed on `(operation_type, business_reference)`, recording
  which operation owns the order and which effect resulted. Long retention.

## Why this option

The two tables answer different questions. "What exactly did we reply?" stops
being useful quickly. "Did this order already move money?" stays relevant for
as long as the payment is disputable.

A retry arriving after pruning therefore gets `409 IDENTITY_EXPIRED` with a
pointer to the existing effect, instead of a second charge. `T8` measures this.

## Managed-service guarantees used

Spanner row deletion policies. Note the documented behaviour: deletion is a
background process, typically delayed by less than 72 hours, so rows can
outlive their expiry by up to about three days. Retention here is a floor, not
a precise boundary, and the design must not depend on a row being gone.

## Consequences

Two tables to keep consistent, both written in the same transaction. The claim
table grows for as long as its retention allows and needs its own lifecycle
decision driven by dispute windows, not by engineering convenience.

## Conditions that would change the decision

If business references were not available - a genuinely unkeyed operation with
no natural business identity - this backstop would not exist and the retention
window would have to be as long as the dispute window.
