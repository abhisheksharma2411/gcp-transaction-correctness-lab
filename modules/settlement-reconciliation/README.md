# settlement-reconciliation

Companion module for Article 19, *From Authorization to Bank Deposit*.

A deterministic settlement corpus, two provider file formats, a bank
statement, five matching rules, an exception workflow, and an explicit
posting decision — plus a conservation oracle that shares no code with the
pipeline it checks.

```
make verify     # strict typecheck, 115 tests, report, negative controls, secret scan
make report     # regenerate results/ (byte-identical on a re-run)
make controls   # print the negative-control matrix
node scripts/explain.ts --subject exp-9201
```

No cloud project, no credentials, no network, no wall clock.

## The experiment

One period of synthetic settlement: 180 internal expectations, 11 delivered
files, 182 provider records, 3 bank entries.

| tie-out | amount |
|---|---:|
| internal expected net | 16,289.81 |
| provider stated net | 16,289.81 |
| bank deposits and debits | 16,289.81 |
| **period difference** | **0.00** |

Seven exception cases sit inside that zero, carrying **1,506.55** of
unexplained amount. They offset: a missing provider record of 436.65 against
an unknown provider record of 436.65; a fee overcharged by 1.20 against one
undercharged by 1.20; a 194.20 shortfall against a 194.20 duplicate; and
242.45 recorded in the wrong currency, which no currency-blind sum can see.

*Simulated result. Reproducible with `make report`.*

## What is modelled

| concern | how |
|---|---|
| source-file identity | SHA-256 of the bytes, not the declared name |
| integrity | CRC32C, the checksum Cloud Storage recommends |
| duplicate file | same digest, same or different name, recorded and not re-ingested |
| name reused with different bytes | `CONTENT_CONFLICT`, never an overwrite |
| corrected file | a declared supersession; the earlier file is retired, not deleted |
| parser version | `format@version` on every record; an old parser refuses a new schema |
| matching | five deterministic rules, in a fixed order, each explained |
| heuristics | `src/suggest.ts`, scored, offered to a person, never applied |
| tolerance | a within-tolerance difference is matched and the residual is posted |
| exception lifecycle | OPEN → ASSIGNED → PENDING_EVIDENCE → RESOLVED / WRITTEN_OFF |
| manual disposition | append-only, named actor, required note, evidence digest checked |
| posting | a separate decision: `POST_SETTLEMENT`, `POST_ADJUSTMENT`, `DEFER`, `HOLD` |
| deposits | one deposit to many batches; a negative payout is a debit |
| replay | the same evidence produces the same accepted result |

## The boundary with Article 14

A provider file is evidence. Evidence alone never produces a posting.

`POST_SETTLEMENT` requires two independent things: a deterministic match rule
fired, **and** a bank entry confirmed the batch the matched record belongs to.
Withhold the bank statement and the same 175 matched rows produce 175 `DEFER`
instructions and nothing posts. An exception produces `HOLD` until a named
person dispositions it, and the disposition is itself evidence.

`src/posting.ts` emits instructions, not journals. Journals, accounts and
balances belong to Article 14's `double-entry-ledger`.

## The oracle is independent

`src/oracle.ts` imports `./types.ts` and nothing else, type-only. It re-reads
the raw bytes by field **name**, converts decimals with `parseFloat` where the
pipeline uses a regex, and sums them its own way.
`tests/controls.test.ts` asserts the import list mechanically.

Conservation is checked **per row**, not per currency. The per-currency
version was written first and could not see the one control that mattered:
two residuals of equal size and opposite sign cancel inside a currency total,
so a mechanism that discarded both left the check green. That is the article's
own argument reappearing inside its checker.

## Boundaries

- **Article 7** owns finality and correctness over duplicate and late *event
  streams*. This module reads *files*.
- **Article 12** owns the idempotency contract. Nothing here reimplements it.
- **Article 14** owns postings and balances. This module decides whether one is
  warranted and stops.
- **Article 21** owns disputes. A chargeback appears as a `Kind` and nothing
  more.
- **Article 22** owns alerting on divergence. This module emits counts.

## Layout

```
src/          types, crc32c, money, intake, parsers, match, suggest,
              exceptions, posting, oracle, pipeline, corpus, controls
tests/        115 tests across eight files
scripts/      report.ts, controls.ts, explain.ts, secret-scan.py
results/      reconciliation.json, explanations.json,
              evidence-manifest.json, report.md
docs/         MODEL.md and four ADRs
```
