# What this module is not

Every way the model departs from the products it is named after. This list is
meant to be unflattering; if it reads as a defence of the module, it is wrong.

## It is not Workflows, Cloud Tasks, Pub/Sub or Cloud Run

Nothing here has ever been deployed. `src/orchestrator.ts` is a loop in one
process, `src/participants.ts` is five objects in that same process, and
`DelayQueue` is an array sorted by a number. No HTTP request is made, no
message is published, no task is created, and no quota, timeout, retry policy,
rate limit or IAM check of any real product is exercised.

Where the article quotes those products, the quotation is the evidence; this
module is not. In particular:

- **Cloud Tasks' dispatch deadline, retry configuration, rate limits and
  ordering behaviour are not modelled.** `DelayQueue` always delivers, exactly
  once, in due order.
- **Pub/Sub is not modelled at all.** There is no topic, no subscription, no
  acknowledgement deadline, no dead-letter topic, no ordering key, and no
  redelivery. The article's choreography section is argued from the
  documentation, not from this code.
- **Workflows' execution model is not modelled.** There is no execution
  history, no retention window, no callback endpoint, no `await_callback`
  timeout, no parallel step, and no exception policy. The comparison between
  orchestration and choreography in the article is a comparison of documented
  properties, not a measurement.
- **Cloud Run's instance lifecycle is not modelled.** The "orchestrator
  crashed" fault throws away an object; it does not deliver SIGTERM, does not
  model a ten-second shutdown window, and does not model a request that is
  still in flight when an instance goes away.

## It is single-threaded, so the concurrency is asserted rather than exercised

Every test runs on one thread. Two workers never contend for the same saga,
and nothing here demonstrates that claim-and-act is atomic. A real
implementation needs that — in Spanner, one read-write transaction — and this
module would not notice if it were missing.

There is no lease and no optimistic version check on the saga record at all.
Article 13 owns both mechanisms; this module simply assumes that one process
advances one saga at a time, which is the assumption a real deployment may not
make.

## The clock is a number

`T0` is a constant and every function that needs the time takes it as a
parameter. There is no clock skew, no timer that fires twice, no deadline that
passes while a request is in flight, and no retry backoff. The "ninety minutes
later" in the carrier callback is an integer added to another integer.

## The participants are caricatures

Each service has one store, one invariant and one refusal. Real services have
schemas, partial failures, their own retries, their own idempotency windows,
their own outages and their own opinions about what a duplicate is.

Specifically:

- **Inventory** refuses to release units while a shipment is booked. That is a
  plausible invariant and it is invented; a real warehouse might allow it, or
  might have released the units already.
- **Payments** has three states and no settlement. A capture is not a
  settlement, a void is not always available, and nothing here models a
  provider that is itself ambiguous. Article 1 owns that case.
- **Fulfilment** answers once, correctly, after a fixed delay. A real carrier
  can answer twice, answer late, answer with a different booking than the one
  requested, or never answer.
- **The ledger** accepts everything. It has no accounts, no postings and no
  balances, and `post_ledger_entry` writes a row with an amount on it. Article
  14 owns what an entry should contain; nothing here checks that anything adds
  up.
- **Notifications** records that it sent something. Nothing is sent.

## De-duplication is one line, and that is a boundary not a simplification

Participants de-duplicate on the command id string they received. Article 12
owns the contract that produces such a string — request fingerprints, conflict
detection, retention windows, the five answers — and none of it is here. The
`no-step-dedupe` mutation shows what happens without it, which is the only
claim this module makes about idempotency.

## The compensations are invented, and so are the attempt caps

Three attempts for a compensation, three or four for a forward step, ninety
minutes for a carrier. None is derived from anything. A number was needed and
one was chosen. The right values depend on how long each participant really
takes and how quickly a person is expected to look.

## The pivot is a business decision stated as a field

`capture_payment` is marked `pivot: true` because this design decided that a
settled capture is not undone by this saga. A capture is technically
refundable. The module does not model a refund, and treating a refund as a
compensation would be a different design with different evidence — one that
Articles 14 and 21 own.

Nothing in the module verifies that the pivot is in the *right* place. The
static checks verify only that there is exactly one, that nothing after it
declares a compensation, and that no irreversible step sits before it. A saga
with the pivot in a commercially ruinous position passes all seven checks.

## The auditor shares one thing with the orchestrator

`src/audit.ts` computes its verdict from the participants' effect records with
no helper shared with `src/orchestrator.ts`. But both read those records: the
orchestrator calls `World.statusOf` when an outcome is unknown or a
compensation is refused, and the auditor reads the same rows.

That is a real limitation. If a participant's ledger were wrong — if it wrote
a record for something it did not do — the orchestrator and the auditor would
agree, and both would be wrong. The independence claimed here is between the
*saga's account of itself* and the *services' records*, and no further.

## Version migration is only half-modelled

The saga carries the definition version it started on and resolves its
compensations against it. There is no migration, no dry run, no blocked list,
and no decision about which in-flight sagas may move. Article 13 owns that
machinery. What is modelled here is one consequence: a compensation for a step
the new version has deleted still has to run.

## The failure matrix is not exhaustive

Thirty-nine runs: six injection points on each of six steps, plus one refusal
on each of the three compensations. It injects one fault per run. It does not
inject two, does not vary the order in which faults arrive, does not model a
participant failing during its own compensation of a different saga, and does
not explore interleavings. A model checker would; this is a table.

## The outcome `PENDING` never occurs in the matrix

Every row reaches a terminal state or a state a person owns. That is a property
of the attempt caps, not a law: the `no-attempt-cap` mutation produces a saga
that never leaves `COMPENSATING`, which is what the column is for.
