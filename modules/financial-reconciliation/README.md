# financial-reconciliation

A reconciliation case corpus and an accounting oracle that keep three things
apart: **delivery de-duplication**, **statement de-duplication**, and
**business finality**.

Companion module for Article 7, *From Event Storm to Financial Truth*.

```bash
make verify
```

No cloud project, no credentials, no network, no runtime dependencies. Node
22.18 or later runs the TypeScript directly.

---

## The invariant

```text
Replaying the same evidence may repeat computation, but it must not silently
create an additional accepted financial effect, and every adjustment must
remain traceable to source evidence.
```

## The result worth reading first

The same 910 deliveries, run at six settings of the pipeline's allowed
lateness, against a correction deadline of five days:

| allowed lateness | dropped | accepted effects | matched | unmatched | exception |
|---|---:|---:|---:|---:|---:|
| 1 h | 318 | 503 | 156 | 164 | 16 |
| 6 h | 27 | 779 | 352 | 22 | 26 |
| 5 d | 0 | 806 | 352 | 22 | 26 |

*Simulated result. Reproduce with `make report`.*

At six hours the pipeline drops 27 pieces of evidence, the accepted financial
position moves by 27 effects, **the case-state summary is identical**, and the
ledger balances in both runs. A reconciliation dashboard built on case states
shows nothing. The full table, including result digests, is in
`results/report.md`.

Nothing is recovered from the stream, because the stream no longer has it. It
is recovered by re-reading the raw objects with a wider window, and the digest
then matches the correct run exactly.

## Five gates, and which ones matter

| gate | catches | load-bearing for money? |
|---|---|---|
| raw store | the same delivery id, stored once, never overwritten | **no** — see below |
| lateness window | nothing; it *drops* evidence | no |
| statement de-duplication | one assertion carried by two delivery ids | yes |
| the engine | one decision per transaction and purpose | yes |
| the ledger | one entry per transaction and purpose | yes, and last |

Removing the first gate reddens exactly one corpus case, and it reddens it on
attribution rather than on money: the gate underneath catches the same
duplicates. The raw store's create-if-absent precondition buys work avoided and
the ability to detect an upstream system reusing an identity. It does not buy
financial correctness, and the negative controls say so.

## Layout

```
src/
  types.ts       the model: evidence, entries, cases, exceptions, resolutions
  identity.ts    three identities, canonical hashing, correlation, digests
  evidence.ts    the immutable raw store (create-if-absent, no update, no delete)
  normalize.ts   raw delivery to normalised assertion; refuses, never repairs
  ledger.ts      balanced entries and the balance oracle
  reconcile.ts   cases, exceptions, finality, versioned resolutions
  pipeline.ts    the five gates, the tally, the result digest
  stream.ts      a deterministic generator of a stream that is already messy
  cases.ts       the case corpus, as data, plus the interpreter and controls
tests/           78 tests
scripts/
  report.ts      every experiment -> results/
  export-cases.ts  the corpus as JSON, with a drift check
  secret-scan.py   credential and card-number scan, with a self-test
docs/
  MODEL.md       every way this departs from Google Cloud, unflattering
  adr/           three decisions that were genuinely contested
reconciliation-cases.json   the published corpus
results/                    generated, byte-identical between runs
```

## What `make verify` runs

| target | gate |
|---|---|
| `typecheck` | strict TypeScript, `erasableSyntaxOnly` |
| `test` | 78 tests across six files |
| `report` | every experiment, written to `results/` |
| `cases` | the exported corpus has not drifted from its source |
| `determinism` | the report is byte-identical on a second run |
| `clock` | no `Date.now`, `new Date()` or `performance.now` anywhere in `src/` |
| `secret-scan` | credentials and Luhn-valid card numbers, plus a self-test |

## The corpus

21 cases in `src/cases.ts`, exported to `reconciliation-cases.json`. Each case
is a JSON document: declarative steps and expectations about accepted financial
effects, case states, exception reasons and which gate stopped each arrival.

Porting the contract to another language or another stack means porting the
interpreter, not the cases.

Seven negative controls, each required to turn specific named cases red:

| mechanism removed | cases that turn red |
|---|---|
| `noDeliveryDedup` | R02 |
| `noRawImmutability` | R18 |
| `noStatementDedup` | R03, R04, R09 |
| `naiveIdentity` | R04 |
| `noCorrelation` | R05, R06 |
| `noEntryDedup` | R10 |
| `noFinalityGate` | R12 |

An eighth control posts everything twice. It reddens 20 of 21 cases and is
**rejected** rather than counted: a mutation that breaks the whole corpus
cannot show which case covers which mechanism.

The corpus passed 21 of 21 on its first run, which proved nothing, because the
same person wrote the implementation and the expectations. The controls are the
evidence that the cases are measuring something.

## Safety and cost

Synthetic data only. No card numbers, no personal data, no employer material,
no endpoints. The module creates no cloud resources and has no deployment path,
so the maximum cloud cost of running it is zero.

## Limitations

`docs/MODEL.md` is the list, and it is long. The three that matter most:

1. The watermark is the maximum event time seen, which is cruder than a real
   watermark in every direction. The *shape* of the lateness result survives
   that; the exact counts are this model's counts.
2. Five banking days is modelled as five times 86,400,000 milliseconds. No
   weekends, no holidays, no settlement-date arithmetic.
3. Correlation arriving after entries have been posted leaves those entries
   filed under the pre-correlation transaction id. The case records where it
   came from and the ledger stays balanced, but the id on an old entry is not
   the canonical one.

## Boundaries with other modules

- **Article 12 / `multi-layer-idempotency`** owns the de-duplication contract
  for one operation crossing a boundary. This module starts where that one ends:
  with the residue that every finite de-duplication window leaves behind.
- **Article 14** owns ledger design. The five accounts here are an oracle.
- **Article 17** owns not losing or duplicating an event at publish time.
- **Article 19** owns provider files, bank deposits and the settlement
  workflow. Settlement appears here only as an assertion in a stream.

Licensed under Apache-2.0, as the repository root states.
