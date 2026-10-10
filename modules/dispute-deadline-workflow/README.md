# dispute-deadline-workflow

A versioned deadline and evidence-manifest engine with deterministic replay.
Companion module for Article 21, *Chargebacks Are Deadline Systems*.

```bash
make verify     # strict typecheck, 112 tests, report, 12 mutations, secret scan
make report     # regenerate every figure the article quotes
make mutate     # break each mechanism and check the named tests go red
make tz-drift   # compare the pinned zone table with this host's (informational)
```

No cloud project, no credentials, no network, and nothing in `src/` reads a
clock.

## What it does

A dispute has a deadline somebody else sets, evidence that has to be collected
and approved, one chance to submit, and a cost for being late that arrives as
silence rather than as an error. This module models that, and the part worth
reading is how little of it is about the state machine.

- **`src/deadline.ts`** — the engine. A provider-supplied deadline is taken as
  stated; the rule set is consulted only when the provider supplies nothing. A
  `due_by` of zero is a sentinel meaning *no response is permitted*, and is
  never read as 1 January 1970.
- **`src/zones.ts`** — time-zone transitions as pinned, versioned data, because
  a deadline that depends on when the host was last patched is not reproducible.
  Two table versions are shipped, differing in one zone, so the same
  notification can be shown producing two different deadlines.
- **`src/calendar.ts`** — business calendars as versioned data: weekend masks,
  holidays, and the local cutoff that ends a day.
- **`src/manifest.ts`** — immutable, versioned evidence packets. The manifest
  hash commits to the sorted items, their content digests, the rule version and
  the deadline basis.
- **`src/timers.ts`** — a durable due row, a sweep, and a renewal chain for
  targets beyond the platform's scheduling horizon.
- **`src/case.ts`** — the case: legal transitions, an append-only audit trail,
  and `stateAt()`, which recovers what the case looked like at any past instant.
- **`src/access.ts`**, **`src/retention.ts`** — access decisions with their own
  log, and the two hold types modelled separately because releasing one of them
  restarts the retention clock and releasing the other does not.
- **`src/submission.ts`** — a provider that accepts one submission, accepts a
  late one without guaranteeing delivery, and can time out after recording it.

## The number this module exists to produce

From `results/report.md`, over seven synthetic cases:

| measured | count |
|---|---:|
| cases that expired with no answer | 1 |
| submissions accepted **past** the deadline | 1 |
| cases the provider permitted no answer to | 1 |
| **errors the system raised** | **1** |

Three cases cost money. One error was raised, and it was for something else
entirely — a duplicate submission the provider refused. A deadline system's
characteristic failure does not throw.

## Negative controls

`make mutate` copies the module, edits one line of the copy, and runs the
suite. A mutation passes only when exactly the tests it named go red and
nothing else does. Twelve mutations; `M12` is the harness control and edits a
comment, so it must break nothing.

Three real defects surfaced this way while the module was being written:

1. `M9` showed a request-time refusal of cardholder-classified evidence to be
   unreachable — the role table had already refused every role. The dead branch
   was removed and the invariant given a test of its own.
2. `M5` showed a test asserting on the wrong object: it counted provisional
   debits on the original case while the mutation was creating a second case
   with a second debit. The test counted across all cases afterwards.
3. `M4` turned two daylight-saving tests red that it had not declared. They
   pick their dates by walking the same business-day window, so they were never
   isolating daylight saving. The declared set was corrected rather than the
   mutation narrowed.

## Determinism

`make report` is byte-identical on re-run, and a test asserts it. Nothing in
`src/` calls `Date.now`, `Math.random`, `new Date()`, `process.env`,
`Intl.DateTimeFormat` or a local `Date` accessor; a test greps for all of them.

## Honesty

`docs/MODEL.md` lists every way this departs from real Google Cloud behaviour,
including the fact that the time-zone tables are synthetic and bounded and that
no Google Cloud product is used at any point. Read it before reusing anything
here.

The module states no network's dispute rules, no deadline durations, and no
win rates. Where provider behaviour is modelled it is attributed to a public
API reference and treated as one provider's choice.
