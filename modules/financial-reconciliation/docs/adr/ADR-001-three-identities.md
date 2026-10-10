# ADR-001: Three identities, and content addressing as the middle one

- Status: accepted
- Date: 2026-10-09

## Context

A reconciliation pipeline has to answer "have I seen this before?" and the
question is ambiguous. Three things can be meant: this delivery, this assertion
of fact, or this business transaction. Most implementations pick one identity
and use it for all three.

The obvious choice is the source's event id. Pub/Sub supplies a message id and
guarantees exactly-once delivery against it within a region; a payment provider
supplies an event id and signs it. Keying de-duplication on that id is cheap,
and every client library hands it to you.

It is also wrong in a way that only shows up in the money. Pub/Sub's own
documentation says publish-side retries lead "to redeliveries with different
message IDs". Stripe's says that "in some cases, two separate Event objects are
generated and sent", and that identifying those duplicates needs the object and
the event type rather than the event id. Both vendors are telling you that
their delivery identity is not an identity for the fact.

## Options considered

1. **Delivery id only.** One `Set` of seen message ids. What almost everyone
   writes first.
2. **Delivery id plus a business key.** De-duplicate on the id; enforce a
   uniqueness constraint on `(transaction, kind)`.
3. **Three identities: delivery, assertion, transaction.** Content-address the
   normalised assertion, correlate references into a transaction, and keep the
   delivery id for the raw object name only.

## Decision

Option 3. `sourceEventId` names the raw object. `evidenceId` is a hash of the
normalised claim with the delivery id and the arrival time deliberately
excluded. `transactionId` comes from a disjoint-set structure over references.

## Why

Option 1 fails case R03: two delivery ids carrying one assertion produce two
assertions and two postings. Option 2 catches that at the business key, but it
catches it by *refusing* rather than by recognising, so a legitimate
re-publication looks like a contradiction and lands in an exception queue a
human has to clear. Separating the assertion identity means a re-publication is
recognised as the same fact and costs nothing.

The cost is real. Content addressing means a source that changes one
insignificant field — a display string, a nullable timestamp it started
populating — produces a new assertion for the same fact, and the engine then has
to decide whether the two are a contradiction. The model handles that at the
case level rather than at the hash, which is why the capture and settlement
guards in `reconcile.ts` exist at all. A hash is not a semantic comparison and
pretending otherwise would have been simpler and wrong.

## Consequences

- The corpus can state which gate stopped which arrival, and the negative
  controls can show that removing delivery de-duplication changes attribution
  but not money (R02), while removing assertion de-duplication changes money
  (R03).
- Normalisation becomes safety-critical, because it decides what is in the
  hash. `normalize.ts` therefore refuses rather than repairs.
- A deployed version needs the assertion hash to be stable across schema
  evolution. This module has one schema version and does not demonstrate that.

## Conditions that would change this

If every source in a platform published a stable, content-derived idempotency
key of its own — and meant it — the middle identity could be theirs rather than
computed. No source read for this article offers that.
