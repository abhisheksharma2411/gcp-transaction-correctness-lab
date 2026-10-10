# What this module models, and where it departs from Google Cloud

This module is a local, deterministic representation of a dual-write pipeline:
a source service, an outbox, a relay, a broker, two consumers, a dead-letter
path and a replay tool. It is not a Google Cloud client. It opens no
connection, holds no credential and needs no project.

That buys determinism and costs fidelity. This page records what was kept and
what was not, so nothing here is mistaken for a description of how the platform
behaves.

## Mechanisms represented

| Mechanism | Modelled as | Faithful in | Simplified in |
|---|---|---|---|
| Database transaction | `OrderService.confirm` | the business row and the outbox row are written in one act, and a crash before it leaves neither | no isolation levels, no aborts, no concurrency, no retry of the transaction body |
| Outbox relay | `OutboxRelay` | claim under a lease, publish, then checkpoint; a crash between the last two republishes | no polling interval, no backoff, no competing instances running at once |
| Pub/Sub publish | `Broker.publish` | each call mints a new message id, so one event republished is two messages | no batching, no flow control, no publish quota, no schema enforcement |
| Pub/Sub delivery | `Broker.pull` | at-least-once; one outstanding message per ordering key when ordering is on | no acknowledgement deadlines, no `StreamingPull`, no push subscriptions, no regions |
| Failed acknowledgement | `Broker.loseAck` | redelivery after an effect has already been applied | the failure is injected, never spontaneous |
| Ordering | `enableOrdering` | within a key only; a redelivery drags later messages for that key back | no publish-side ordering failures, no affinity, no hot-key latency |
| Dead-letter topic | `maxDeliveryAttempts` | a floor of 5 attempts; a forwarded message leaves the subscription | the count is exact here and approximate at the platform; see below |
| Seek | `Broker.seek` | acknowledged messages become unacknowledged and delivery attempts reset to zero | instant and exact; the platform's seek is eventually consistent |
| Consumer inbox | `Consumer.inbox` | the inbox row and the effect are written together | single-process; no transaction spans them in any real sense |
| Schema versions | `knownVersions` | an unknown version is routed, never dropped | no Avro or protocol-buffer validation, no revision ids, no compatibility checking |

## Departures, stated plainly

**The dead-letter count is exact here and approximate at the platform.** The
model forwards on exactly the configured attempt. Pub/Sub's documentation says
the maximum is approximate, that it forwards on a best-effort basis, that it
might forward after fewer attempts or a few more, and that the tracked count
"may also reset to zero, especially for a pull subscription with inactive
subscribers." Any test here that depends on the exact attempt number is
depending on something the platform does not promise.

**Seek is instant here and eventually consistent at the platform.** The
documentation states that a message published before the seek timestamp might
still be delivered after the seek, and that the operation can take as long as a
minute to take full effect. The model's `seek` returns with the subscription
already in its new state. A real replay therefore has an overlap window this
module never produces.

**There is no concurrency.** One process, one thread, no interleaving. Two
relay instances never race for the same outbox row; the lease is modelled as a
field, not enforced by a database. The claim-and-publish and the
inbox-and-effect pairs are atomic here because nothing else is running, not
because anything made them atomic. In Spanner each would be one read-write
transaction, and this module cannot demonstrate that it is.

**The transaction is a function call.** `OrderService.confirm` writes two maps
and records a commit. There is no isolation, no abort, no replication, and no
possibility of the transaction body running twice — which Spanner's
documentation says can happen, and which would matter to any side effect placed
inside it.

**Sequence numbers are gap-free because one process assigns them.** A real
aggregate version comes from a row the writer read and incremented inside the
transaction. Under contention that is where the interesting failures live, and
none of them are here.

**The broker never loses a message.** Retention is unmodelled. Pub/Sub's
subscription message retention is 7 days by default with a maximum of 31, and
after it passes the service "might discard the message independent of the
acknowledgment state." Nothing here expires, so the model cannot show the case
where a replay is attempted after the messages have gone.

**Publish failure is unmodelled.** `Broker.publish` always succeeds. A real
publish can fail, and with an ordering key a failure poisons the rest of that
key until the publisher resumes it. The relay here has no such state.

**Schema enforcement is unmodelled.** Pub/Sub can reject a message that does
not conform to a topic's schema, which turns an outbox row into a row that can
never be published. The model's unknown-version handling is consumer-side only.

**The effect ledger is a map in memory.** A real protected effect is a row in a
database with a unique constraint, or a call to a system that will refuse a
duplicate. The model's guard is only as good as the process holding it.

**One topic, two consumers, one region.** No fan-out across projects, no
cross-region subscribers, no filters, no export subscriptions, and therefore
none of the exactly-once delivery feature's regional and subscription-type
restrictions.

**Time is a parameter, never a clock.** Every function that needs the time
takes it. There is no `Date.now()` anywhere in `src/`, which is why
`make report` produces identical bytes on every run.

## Reproducing

```
make verify     # strict typecheck, 73 tests, report, lineage gate, secret scan
make report     # regenerate results/
make lineage    # the verifier plus every negative control
make replay     # bounded replay, dry run
```

Node 22.18 or newer. No npm install is needed to run the tests; installing
TypeScript only enables the strict typecheck.
