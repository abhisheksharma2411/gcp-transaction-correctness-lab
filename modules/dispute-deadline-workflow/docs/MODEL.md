# What this module is not

Every way the model departs from real Google Cloud behaviour, and every claim
it is not entitled to make. Written to be unflattering, because a model whose
limits are undocumented is read as a reference implementation.

---

## 1. The time-zone tables are synthetic

`src/zones.ts` contains hand-written transition lists for six zones over a
window of roughly six months. They are **not** the IANA Time Zone Database, not
derived from it, and not complete.

- The modelled window is 2026-09-01 to 2027-03-01, declared as
  `MODELLED_WINDOW`. Outside it the tables return whichever transition came
  last, which is arithmetically well defined and factually wrong.
- Six zones are present: `UTC`, `Asia/Kolkata`, `America/New_York`,
  `Europe/London`, `Australia/Lord_Howe`, `America/Winnipeg`. Any other zone
  raises rather than defaulting.
- Historical transitions before 2026 are absent entirely. Each zone has one
  base entry dated 1970 carrying its standard offset.
- The two table versions, `synthetic-2026d` and `synthetic-2026e`, differ only
  in Winnipeg. They are named after IANA release identifiers because they model
  a change recorded in one of them; they are not those releases.
- The Winnipeg transition instant is this module's own reading of one sentence
  — "Manitoba moves to permanent -05 on 2026-10-31" — placed at midnight UTC on
  that date. The real rule may take effect at a different local instant. The
  article does not depend on the exact instant, only on the fact that it moved.

`scripts/tz-drift.ts` compares the pinned table to the host's database and
prints disagreements. On the machine this module was written on, running Node
v25.2.1, four probes disagree, all of them Winnipeg: the host still applies the
older rule. That is the point of pinning, and it is also a demonstration that
the pinned table is not authoritative about the world.

## 2. There is no Google Cloud here at all

No Cloud Tasks queue, no Workflows execution, no Cloud Storage bucket, no
Spanner instance, no IAM, no audit log. Nothing authenticates, nothing bills,
nothing is deployed. Every Google Cloud behaviour the module models is a
published number or a documented rule that has been reimplemented locally:

| modelled here | what it stands for | what is missing |
|---|---|---|
| `MAX_SCHEDULE_HORIZON_MS` | the Cloud Tasks maximum schedule time | queues, dispatch rates, retry configuration, the 31-day task retention that deletes an unfired task |
| `scheduleNext` / `onFire` | a task that fires, or does not | network failure, worker timeouts, `dispatchDeadline`, at-least-once dispatch |
| `sweep` | a scheduled scan over durable rows | the database, its indexes, its cost, its pagination |
| `submit` | a provider API call | TLS, authentication, rate limits, partial responses, schema validation |
| `retention.ts` | Cloud Storage retention policies and the two hold types | bucket locks, project liens, lifecycle rules, object versioning, KMS interaction |
| `access.ts` | an authorization check plus its own access log | IAM, Cloud Audit Logs, VPC Service Controls, org policy |
| `AuditEntry` | an append-only transition history | durability, replication, ordering under concurrency, schema evolution |

## 3. The provider model is one provider, simplified

`src/submission.ts` models a provider that accepts one submission per case,
accepts late submissions without guaranteeing delivery, and can time out after
recording the work. Those behaviours were chosen because a public API reference
documents them for one real provider. They are **not** universal, they are not
network rules, and no claim is made that any particular provider behaves this
way today.

The module does not model: reason codes and what they require, retrieval
requests preceding a chargeback, second presentments, pre-arbitration,
arbitration, provider-side validation of evidence content, fee schedules, or
any scheme's published timetable. Reason codes are carried as opaque strings
and never interpreted.

## 4. The deadline is never derived when the provider states one

This is a design decision, not a model of anything. When the provider supplies
a deadline, the engine uses it and the rule set is not consulted. A real
integration might reasonably want to sanity-check a supplied deadline against a
contractual window and raise an exception when they disagree. This module does
not, and `D10` shows the consequence: a notification whose stated deadline has
already passed opens a case that is immediately past due, with no complaint.

## 5. Concurrency is absent

Everything runs in one thread, in order, with no locking, no optimistic
version check on write, and no transaction. Two analysts approving two
different evidence sets at the same instant is not modelled and would not be
handled correctly if it were attempted. The `generation` counter on a case
exists to discard stale timer fires, not to serialise writes. Article 13's
module is where durable-state concurrency belongs.

## 6. Evidence bytes never exist

`contentHash` is a digest of a short label, not of a document. Nothing is
uploaded, stored, scanned, redacted or rendered. Sensitive Data Protection is
referenced in the article and not used here; `redactionProfile` is a string
that is recorded and never acted on.

Consequently the module cannot demonstrate that redaction works, only that the
system records which profile was claimed. That is a weaker claim than it looks
and should not be read as a de-identification control.

## 7. No model decides anything

`origin: 'MODEL_SUGGESTED'` exists so that the approval rule can refuse a
packet made only of generated material. No model is called, no inference runs,
and the module takes no position on whether generated summaries are useful. The
only enforced property is that generated material cannot be the whole of what a
human approves.

## 8. The financial side is events, not accounting

`AdjustmentEvent` records that a provisional debit, a reversal, a fee or a
confirmed loss occurred. There are no accounts, no postings, no balances, no
double entry, and no settlement. The totals in `results/report.md` are sums
over events and are not a ledger. Article 14 owns the ledger and Article 19
owns settlement.

## 9. Determinism is enforced, and that is itself a departure

No clock is read anywhere in `src/`, enforced by a test that greps the sources
for `Date.now`, `Math.random`, `new Date()`, `process.env`, `Intl.DateTimeFormat`
and the local `Date` accessors. Real systems read clocks. The point of removing
them is that a deadline engine's behaviour must be a function of its recorded
inputs, so that a past decision can be re-derived; the cost is that this module
cannot demonstrate anything about clock skew, NTP, or the behaviour of a
process whose host clock jumps.

Related: Google Public NTP smears leap seconds across 24 hours, so a Google
host's clock deliberately disagrees with UTC around a leap second. That is
irrelevant at the scale of a multi-day deadline and is mentioned in the article
only to make the point that "the clock" is a choice. It is not modelled.

## 10. The mutation harness proves less than it appears to

`scripts/mutate.ts` edits one line of a copy of the source and checks that
exactly the named tests fail. That is a real check and it found three genuine
defects while this module was being written. It is still bounded by
imagination: it tests the twelve mutations somebody thought of. A mechanism
nobody wrote a mutation for is a mechanism nobody has checked.

## 11. What the numbers in `results/` are

Simulated. Seven synthetic cases, chosen to produce one of each interesting
outcome. The money figures are arbitrary minor units. The ratio of lost to
recovered cases is a property of the fixture list and says nothing whatsoever
about dispute outcomes in the world.
