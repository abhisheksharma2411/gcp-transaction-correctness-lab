# What this model is, and every way it departs from Google Cloud

This module is a local, deterministic model of a reconciliation pipeline. It
has no Google Cloud client, opens no socket, and reads no credential. It exists
to make a small number of claims testable, and this file is the list of things
it does *not* do, written to be unflattering rather than reassuring.

Verified against documentation read on **2026-10-09**. Page dates are in
`../../../articles/article-07-financial-truth/research/source-matrix.md`.

---

## The behaviours it models, and the gap in each

### 1. Immutable raw evidence (`src/evidence.ts`)

**Modelled on:** Cloud Storage request preconditions. A generation-match
precondition with the value 0 "only proceeds if no object with the specified
name exists in the bucket", and a live object of that name fails the request
with 412. Object Retention Lock adds that before the retain-until time "the
object cannot be deleted or replaced", and a Locked retention mode
"permanently prevents the retention date from being reduced or removed".

**What the model does:** a `Map` keyed on `source/sourceEventId` with no
update and no delete method, returning `STORED`, `DUPLICATE_DELIVERY` or
`PRECONDITION_CONFLICT`.

**Gaps:**

- No object versioning, no noncurrent generations, no lifecycle rules. Cloud
  Storage's precondition has a documented exception for buckets that hold only
  noncurrent versions of a name; the model has no such state.
- No storage classes, no regional placement, no replication delay. A real
  bucket in a dual-region configuration can serve a read that does not yet show
  a write made in the other region; the model is a single in-process map and
  cannot show that.
- No retention policy is actually enforced by anything. The model gets its
  immutability from the absence of a method, which is a property of this code
  and not of a bucket. A deployed system needs the bucket configuration, and a
  bucket configuration can be wrong.
- Audit logging is not modelled at all. Object Retention Lock's documentation
  pairs it with Detailed audit logging mode for regulatory use; nothing here
  produces an audit log.

### 2. Delivery semantics (`src/pipeline.ts`, gate 1)

**Modelled on:** Pub/Sub exactly-once delivery, which is scoped "within a cloud
region, based on a Pub/Sub-defined unique message ID", is supported only by
pull subscriptions, and does not prevent publish-side duplicates — "multiple
unique publishes by the publishing client, across retries, leads to
redeliveries with different message IDs".

**What the model does:** treats `sourceEventId` as the delivery identity, and
separately content-addresses the assertion so that two delivery ids carrying
one assertion collapse.

**Gaps:**

- No acknowledgement deadlines, no lease extension, no negative
  acknowledgement, no dead-letter topic, no subscription backlog.
- No ordering keys. Pub/Sub orders messages that share an ordering key and are
  published in the same region; the model has no ordering guarantee at all and
  the corpus asserts that it does not need one (R17).
- The model never loses a message. Real transport can, and the only defence
  against that is a completeness check against the source, which this module
  does not implement.
- Pub/Sub's own page contains a tension the model inherits: it states that
  "subscriptions with exactly-once delivery enabled don't receive duplicate
  deliveries" and, further down, that a subscription "might receive multiple
  copies of the same message due to publish side duplicates, even with
  exactly-once delivery enabled". Both are true under the page's narrow
  definition of a duplicate. The model takes the second as the operative one.

### 3. The lateness window (`src/pipeline.ts`, gate 2)

**Modelled on:** Beam's watermark and allowed lateness. Beam's "default
windowing configuration tries to determine when all data has arrived ... and
then advances the watermark past the end of the window. This default
configuration does not allow late data." Dataflow adds that exactly-once
processing "cannot guarantee that results are complete, because records might
arrive late", and that "there is no way to guarantee completeness in a
streaming pipeline".

**What the model does:** a single global watermark equal to the highest event
time processed so far, and a record is dropped when its event time is behind
that watermark by more than the configured lateness.

**Gaps — this is the largest set, and the experiment depends on them:**

- A real watermark is produced by the source and is a heuristic estimate, not
  the maximum timestamp seen. It can advance when no data has arrived, it can
  be held back, and per-key and per-stage watermarks differ. The model's
  watermark is cruder in every direction.
- There are no windows. Beam drops late data per window, with triggers
  deciding when a window emits and whether it emits again; the model drops per
  record against one global threshold. The shape of the result — evidence lost
  when the window is shorter than the correction deadline — survives this
  simplification, but the exact counts in `results/report.md` are the model's
  counts and not Dataflow's.
- Dataflow also garbage-collects the record ids it de-duplicates against: "if a
  record arrives with a timestamp older than the watermark, and if IDs for this
  time have already been garbage collected, the record is ignored." The model
  has no such collection and therefore cannot show that failure mode.
- Nothing here models at-least-once streaming mode, whose documented duplicate
  rate has a "baseline rate ... typically low (<1%)" with spikes on worker
  failure. The model's duplicate rate is whatever the generator plants.

### 4. Accepted financial effects (`src/ledger.ts`)

**Modelled on:** a double-entry journal, and on Spanner's transactional
guarantees for the store that would hold it. Spanner commits a read-write
transaction atomically at one commit timestamp, and commit timestamps based on
TrueTime let you "determine the exact ordering of mutations and build features
like changelogs".

**Gaps:**

- The ledger is five accounts and a sum-to-zero check. It is an oracle, not an
  accounting design. Article 14 owns posting rules, period close, balance
  reconstruction and the chart of accounts.
- No transactions. Nothing here is atomic with anything else; the module is
  single-threaded and the `post` call either happens or throws.
- No concurrency. Spanner "might execute a transaction's operations multiple
  times internally" and side effects from a retried transaction body "might
  occur multiple times"; the model never re-runs a body and so never
  demonstrates the thing that makes a deterministic entry id necessary in the
  first place.
- Commit timestamps are not modelled. Entries carry the event time of the
  evidence, not a commit order, so the module cannot show the difference
  between the order things happened and the order they were recorded.
- No currency conversion, no rounding policy, no multi-currency netting. Every
  case in the corpus is single-currency, and the balance check is per currency
  only because it was cheap to write that way.

### 5. The correction window (`src/reconcile.ts`)

**Modelled on:** Nacha's reversal rules. An Originator or ODFI "must still
transmit a Reversal in such time that it is made available to the RDFI within 5
banking days following the Settlement Date of the Erroneous Entry", and a
reversal's "Standard Entry Class Code field, the Company Identification field
... and the amount field remain unchanged from the original Entry".

**Gaps:**

- Five *banking* days is not five calendar days. The model uses
  `5 * 86_400_000` ms and knows nothing about weekends, holidays or
  settlement-date arithmetic. Every number in the lateness sweep inherits that
  simplification.
- ACH is one network. Card schemes, wallets, bank transfers and invoices each
  have their own correction deadlines, and a real platform has several running
  at once against one ledger. The model has one global window.
- Return reason codes, R11 and R17 timeframes, improper reversals and the
  arbitration process are not modelled. The module has one `INVALID_CORRECTION`
  reason where the rules have a taxonomy.
- The model's correction matching requires the kind, currency and reference to
  agree. Nacha requires the SEC code, company identification and amount to be
  identical; the model's amount is the thing being corrected, so the
  correspondence is a reading of the intent rather than an implementation of
  the rule.

### 6. Correlation (`src/identity.ts`)

**Modelled on:** nothing in Google Cloud. Stripe's webhook documentation says
that "in some cases, two separate Event objects are generated and sent", and to
identify those duplicates "use the ID of the object in `data.object` along with
the `event.type`" — which is the same observation from the provider's side.

**Gaps:**

- Correlation is a disjoint-set structure over reference strings. A real
  platform correlates on amounts, timestamps, order ids and merchant references
  with fuzzy matching, and gets it wrong sometimes.
- **A known, deliberate limitation:** when a correlating record arrives after
  entries have been posted under a reference that turns out to belong to
  another transaction, the earlier entries keep the transaction id they were
  posted with. The case records where it came from in `mergedFrom` and the
  ledger stays balanced, but the transaction id on an old entry is not the
  canonical one. Rewriting it would mean editing an accepted financial effect,
  which this module will not do. A deployed system needs either a mapping table
  the reporting layer consults or an explicit re-filing entry, and this module
  implements neither.

### 7. Analytics storage

**Not modelled at all**, and that is the point of one section of the article.
BigQuery is where these results would be read, not where they would be decided.
Relevant documented behaviour that the module deliberately does not reproduce:
the Storage Write API's default stream "supports at-least-once semantics", so
"duplicate records" can appear in the destination table; exactly-once writes
come from committed-type streams "within a stream through the use of record
offsets", which says nothing about two streams writing one business fact; and
the time travel window "covers the past seven days by default" with a maximum
of seven, so a table's own history is shorter than many correction deadlines.

### 8. Everything operational

No IAM, no service identities, no VPC Service Controls, no encryption, no KMS,
no quotas, no cost, no monitoring, no alerting, no lineage. Data lineage in
Knowledge Catalog "is recorded only for BigQuery tables and views", which is
worth knowing and is not something this module can demonstrate.

---

## Determinism

`src/` contains no `Date.now()`, no `new Date()` and no `performance.now()`;
`make clock` fails the build if one appears. Every function that needs the time
takes it as a parameter, and the one random generator is a seeded linear
congruential generator documented as statistically weak and chosen because it
is reproducible.

`make determinism` runs `scripts/report.ts` twice and compares the bytes. Wall
clock timings are printed to the terminal and kept out of `results/`.

## What a passing `make verify` does and does not tell you

It tells you that 78 tests and 21 corpus cases pass, that each of seven removed
mechanisms turns specific named cases red, that a blunt mutation is rejected
rather than counted as a success, that the report reproduces byte for byte, and
that a planted card number is still detected by the secret scanner.

It tells you nothing about whether this design works on Google Cloud. Nothing
here has been deployed, and the article says so.
