# multi-layer-idempotency

A language-neutral idempotency contract, and an executable conformance matrix
that checks an implementation against it.

Companion lab for Article 12, *Idempotency Is More Than a Header*.

No cloud project. No credentials. No network. `make verify` runs everything.

## The idea

One logical operation can arrive six different ways — an HTTP client retried, a
message was redelivered after a failed acknowledgement, a queued task retried, an
orchestrator retried a step, a provider's webhook fired twice, an operator
replayed it during a recovery. Each boundary repeats work for its own reasons,
and handling one of them is not idempotency. It is luck.

So the contract is one pure function with five answers:

| decision | meaning |
|---|---|
| `FIRST` | never seen; proceed |
| `IN_PROGRESS` | seen, still running; do not start a second effect |
| `REPLAY` | seen and finished; return the recorded outcome |
| `CONFLICT` | same key, different request; refuse |
| `EXPIRED` | seen, but no longer authoritative |

Four independent layers can stop a duplicate, and the module records **which
one did**:

```
contract  ->  business-uniqueness  ->  provider  ->  effect-ledger
```

That record is the point. A system that is correct only because its outermost
layer happened to catch everything is one eviction away from being wrong.

## The result

One operation, arriving through every boundary that can repeat it:

| measured | count |
|---|---:|
| copies that arrived | 13 |
| admitted past de-duplication | 1 |
| calls made to the provider | 1 |
| **externally visible effects** | **1** |

Then the same operation seven days later, after the record has aged out of its
retention window:

| layer | arrivals stopped |
|---|---:|
| business-uniqueness | 1 |
| effect-ledger | 1 |
| did real work | 1 |

The contract has nothing left to say, and the layers beneath it are the only
thing between a recovery replay and a second effect. Every de-duplication window
is finite, so every system eventually runs this scenario — usually during a
recovery, which is the worst moment to find out the answer.

Full output in [results/report.md](results/report.md).

## The conformance matrix

Twenty cases, written as **data** rather than as assertions, so that an
implementation in Java, Go or Kotlin can satisfy the same contract by porting a
~120-line interpreter and running the identical matrix.

```
node scripts/export-matrix.ts    # writes conformance-matrix.json
```

Each case names the required behaviour it covers, so the matrix can be audited
against the article's claims without reading the implementation.

The matrix passed 20/20 on its first run, which proves nothing when the same
author wrote both sides. Four mutations exist for that reason — each removes one
layer, and each must turn specific named cases red:

| layer removed | cases that turn red |
|---|---|
| `no-fingerprint-check` | C04 |
| `no-business-uniqueness` | C06, C12, C16 |
| `no-effect-ledger` | C15 |
| `naive-fingerprint` | C05 |

A mutation that reddens the whole matrix is rejected too — a blunt control
cannot show which case covers which layer.

## Layout

```
src/contract.ts      the decision function: pure, no clock, no store, no I/O
src/fingerprint.ts   canonical request hashing, hashed task ids, effect identity
src/store.ts         the record (expires) and the business constraint (does not)
src/effects.ts       the effect ledger and a provider that honours a key
src/processor.ts     the four layers, and which one caught each arrival
src/boundaries.ts    the six arrival paths and the limits of each
src/conformance.ts   the matrix, as data, plus its interpreter
tests/               58 tests, including 5 negative controls
scripts/             report, matrix export, operator replay CLI
docs/                MODEL.md and three ADRs
```

## Running it

```
make verify     # strict typecheck, 58 tests, report, matrix drift check, secret scan
make report     # regenerate every table above
make replay     # operator replay against an evicted record
node scripts/replay.ts --help
```

Node 22.18 or newer. `npm install` is optional and only enables the typecheck.

## Honesty notes

- **Concurrency is modelled, not exercised.** There are no threads here. A real
  implementation must make claim-and-check atomic, and this module cannot
  demonstrate that it does. [`docs/MODEL.md`](docs/MODEL.md) lists every
  simplification.
- **No retention period is recommended.** Cloud Tasks' documented 24-hour /
  9-day window is cited as evidence that such windows exist and are finite, not
  as a number to copy.
- **No claim is made about HTTP method semantics.** No RFC was read. The module
  models what the platform does, not what a verb is supposed to mean.
