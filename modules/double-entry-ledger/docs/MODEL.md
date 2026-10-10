# What this model is not

`src/spanner.ts` is about 300 lines of TypeScript. Spanner is a distributed
database. This file lists every way the model departs from the product, so that
nobody reads a passing test here as a statement about a real instance.

The rule used while building it: model a behaviour only when getting it wrong
could change whether debits equal credits. Everything else is absent, and
absence is listed below rather than left to be discovered.

## Modelled, and why

| behaviour | why it is here |
|---|---|
| A read-write transaction body may run more than once | Anything the body derives must be a pure function of its inputs, or a retry writes a second journal |
| Mutations are buffered and visible only at commit | A body that reads its own uncommitted write would see a different ledger than the one that commits |
| Mutations are counted per column, against a per-commit limit | A large journal is refused, not split, and the limit is reached by column count rather than row count |
| Commit timestamps are not unique across non-overlapping writes | A commit timestamp alone cannot be a journal sequence number |
| Privileges are granted per table, and a parent grant does not reach an interleaved child | This is what makes a posting immutable, and the propagation rule is the easy half to forget |
| Database-level IAM is not filtered by a database role | Otherwise the model would overstate how much immutability the privileges buy |
| A change stream watches a table, not an application | A projection sees writes the application layer did not make |
| Records of one transaction can be split across partitions | A consumer reading one partition observes a journal that does not balance |

## Not modelled

**No replication, no Paxos, no regions.** There is one in-memory map. Nothing
here says anything about multi-region authority, leader placement, or what a
partition does to availability. That subject belongs to Article 3.

**No external consistency, only an assertion about it.** The model takes a
`tick` from the caller and refuses a commit that would reuse a tick for an
overlapping key. Real external consistency is a property of TrueTime; here it
is an input the test supplies. Nothing in this module demonstrates that
Spanner provides it.

**No locks, no deadlocks, no wound-wait.** `L06` shows that maintaining a
balance column introduces a read of the row it then writes, and the model
refuses to give two such transactions the same commit tick. That is a hint at
contention, not a measurement of it. There is no lock manager here and no
abort caused by one; the aborts in `S01` and `L04` are injected by a test
parameter.

**No performance of any kind.** No latency, no throughput, no split
behaviour, no load-based splitting. The hotspot argument in the article rests
entirely on the documentation, not on anything measured here. There is no
benchmark in this module and no number in the article is a latency.

**No threads.** "Concurrent postings to the same account" in `L05` means two
sequential posts whose write sets do not overlap. Real concurrency would
require the claim-and-check to be atomic, which in Spanner is one read-write
transaction, and the model cannot demonstrate that it is.

**No SQL, no DDL, no query planner.** `docs/SCHEMA.sql` was never executed.
Table and index definitions, `CHECK` constraints, `allow_commit_timestamp`,
`INTERLEAVE IN PARENT`, `ON DELETE NO ACTION`, change stream options and
`GRANT` statements are all unverified against a real instance. The privileges
in `src/spanner.ts` are a hand-written approximation of what those grants
would do.

**No TTL sweeper.** The argument that a row deletion policy on a standalone
postings table could tear a journal apart comes from the documented batching
behaviour, not from a sweeper in this code. `INV-4` would catch the result; it
has never seen one.

**No real change stream.** Records are emitted by `SpannerModel` at commit,
with a partition chosen by hashing the account id. Real partitions split and
merge over time, emit child partition records and heartbeat records, and carry
tokens rather than names. None of that is here. The one property that is
modelled faithfully is that a transaction's records can land on more than one
partition.

**No `UPDATE` or `DELETE` change records.** The stream only emits inserts,
because the ledger only inserts. The mutation that deletes a posting
(`M5`) bypasses the stream entirely, which overstates how invisible a deletion
would be in a real system — a change stream would report it.

**No commit timestamp written by the server.** `recordedAt` is derived from
the caller's tick. The real `PENDING_COMMIT_TIMESTAMP` makes the table
unreadable for the rest of the transaction, which this model does not
reproduce and which would constrain where in a body the write can go.

**No sessions, no client library, no retry budget.** `maxAttempts` is a
number in an options object. Real retries have backoff, a deadline, and a
lock-priority escalation on each `ABORTED`.

**No cost model.** The mutation counts in `results/report.md` are arithmetic
over column counts, not a bill. They do not include index entries for
`PostingsByAccount`, which a real commit would count.

## Accounting, not claimed

The chart of accounts in `src/scenario.ts` is synthetic. The treatment of an
authorization hold as a posting pair against a contra account is a modelling
choice made for this article, not a statement about how any accounting
standard requires authorizations to be recorded. Nothing in this module is
advice about recognition, measurement, presentation, disclosure, tax or audit.

The foreign-exchange bridge records the rate that was used and keeps each
currency balancing on its own. It does not compute gain or loss on
revaluation, does not handle rate sources, and does not model settlement
risk. The module refuses a cross-currency journal that has no bridge posting
and no recorded rate; that is the whole of its foreign-exchange behaviour.

"Period close" here is one date and one rejection code. A real close involves
accruals, reversing entries, subledger cut-offs and sign-off, none of which
is modelled.

## Determinism

No `Date.now()` anywhere in `src/`. Every function that needs an instant takes
it as an argument, and `make determinism` re-runs the report and fails if a
single byte changes. The identifiers in the output are content hashes, so they
are stable across machines; they are also truncated to 128 bits, which is fine
for a demo and would want justifying in anything real.
