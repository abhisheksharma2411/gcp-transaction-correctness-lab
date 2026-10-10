# What this module models, and where it departs from Google Cloud

This module is a local, deterministic representation of six mechanisms that can
each repeat work. It is not a Google Cloud client. It opens no connection, holds
no credential, and needs no project.

That buys determinism and costs fidelity. This page records what was kept and
what was not, so nothing here is mistaken for a description of how the platform
behaves.

## Mechanisms represented

| Mechanism | Modelled as | Faithful in | Simplified in |
|---|---|---|---|
| Pub/Sub redelivery | `TransactionalInbox` | redelivery follows a *failed acknowledgement*, not a failed effect; publish-side duplicates arrive with distinct ids and are not deduplicated | no ack deadlines, no `StreamingPull`, no ordering keys, no dead-letter topics |
| Cloud Tasks name de-duplication | `DeduplicatingQueue` | a repeated name is refused; the window is finite and configurable; ids are hashed rather than sequential | no queue rate limits, no retry configuration, no actual dispatch |
| Workflows step retry | `RetryingWorkflow` | a retry either carries the operation id or mints a new one, and the two produce different outcomes | no step graph, no backoff, no predicates |
| Provider idempotency | `SimulatedProvider` | a repeated key returns the first result; a timed-out call still happened at the provider; a stable key makes lookup possible | no HTTP, no partial failures, no key retention limit at the provider |
| Database transaction | `IdempotencyStore` | a primary key on the operation and a unique constraint on the business reference, claimed together | single-process, no isolation levels, no actual concurrency |
| Operator replay | `operatorReplay` | no de-duplication of its own, by construction | no tooling, no authorisation, no audit |

## Departures, stated plainly

**Concurrency is modelled, not exercised.** The `IN_PROGRESS` decision and case
`C02` describe what a second copy sees while the first is still running, and the
model produces that state by leaving an operation open after an unknown provider
outcome. There are no threads here. A real implementation must make the
claim-and-check atomic — in Spanner that is one read-write transaction — and
this module cannot demonstrate that it does.

**Spanner's own retry behaviour is cited but not modelled.** The documentation
states that "Spanner might execute a transaction's operations multiple times
internally," which means the transaction body itself is a boundary that can
repeat work. The article makes that point; the store here does not simulate it.

**Provider key retention is unmodelled.** `SimulatedProvider` remembers keys
forever. Real providers do not, and a key that has aged out at the provider is
another instance of ADR-002's problem one layer further out.

**Effect identity is derived, not assigned.** `effectId(operationId, kind)` is a
hash. A real system often has a natural effect identity — a deterministic
resource name, a message id the downstream system will reject as a duplicate —
and that is better, because it is enforced by something other than your own
code.

**The four tallies are counted in one process.** `arrivals`, `admitted`,
`providerAttempts` and `effects` are instance fields. Counting them in a real
distributed system is a genuine problem and the article does not claim
otherwise.

**No HTTP method semantics are claimed.** No RFC was read while writing this.
The module makes no claim that any verb is inherently safe; it models what the
platform does, which is to treat every non-GET connector call as non-idempotent
by default.

**Time is a parameter, never a clock.** Every function that needs the time takes
`nowMs`. There is no `Date.now()` anywhere in `src/`, which is why `make report`
produces identical bytes on every run.

## Reproducing

```
make verify     # typecheck, 58 tests, report, matrix drift check, secret scan
make report     # regenerate results/
make replay     # operator replay against an evicted record
```

Node 22.18 or newer. No npm install is needed to run the tests; installing
TypeScript only enables the strict typecheck.
