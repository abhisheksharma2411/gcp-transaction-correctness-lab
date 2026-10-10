# double-entry-ledger

Companion module for Article 14 — *How to Build a Double-Entry Ledger on
Spanner: Immutable Postings, Balances, Reversals, and Audit*.

An append-only ledger with an invariant checker that rebuilds balances from the
postings and compares them with the projection, producing a machine-readable
proof report on every run.

No cloud project. No credentials. No network. Zero runtime dependencies.

```
make verify    # strict typecheck, 77 tests, proof report, determinism check, secret scan
make trace     # trace one journal, its reversal, and the change records both produced
make report    # regenerate results/
```

## What it does

- Opens synthetic ledger accounts with one currency each.
- Posts balanced journals atomically, and refuses unbalanced, duplicate,
  cross-currency-without-a-bridge, closed-period and foreign-ledger ones.
- Rebuilds balances from immutable postings, and maintains a separate
  projection by consuming a change stream.
- Reverses an accepted journal with a linked journal, leaving the original
  untouched.
- Exports a traceable audit report in which every balance names the postings it
  came from.
- Runs entirely against an in-memory model of the Spanner behaviour that
  matters; `docs/MODEL.md` lists every way that model is wrong.

## The contribution

Nine named invariants over the ledger and its projection, each one reporting
**the size of the population it examined**.

| invariant | what it uniquely catches |
|---|---|
| INV-1 journal balanced | a journal whose debits and credits differ was accepted |
| INV-2 posting log intact | a posting was altered or removed after it was written |
| INV-3 projection equals rebuild | the cached balance drifted from the postings that determine it |
| INV-4 no orphan postings | a journal and its postings were torn apart |
| INV-5 reversal nets to zero | a correction that did not undo what it claimed to |
| INV-6 currency consistent | two currencies summed into one balance |
| INV-7 period and time separation | a backdated entry that lost its recorded time |
| INV-8 trial balance | an imbalance spread across journals that each look fine alone |
| INV-9 business reference unique | one event posted twice under two journal ids |

A report in which any invariant examined zero items is `INCONCLUSIVE`, not
`PROVEN`. An invariant that holds vacuously is the most comfortable kind of
green there is, and it is the one this checker refuses to give you.

## Negative controls

The checker reported nine of nine on its first run, which proved nothing: the
same person wrote the ledger and the invariants. Six mutations each remove one
mechanism and must redden a **named** set of invariants.

| mutation | reddens |
|---|---|
| M1 no balance check | INV-1, INV-8 |
| M2 projection without an inbox | INV-3 |
| M3 posting ids minted in the transaction body | INV-4 |
| M4 money as a double | INV-1, INV-8 |
| M5 DELETE left on the writer role | INV-3, INV-4, INV-8 |
| M6 a balanced edit of an accepted journal | INV-2 |

M6 is the interesting one. Both sides of a journal are raised by the same
amount and the projection is rebuilt afterwards, so the journal balances, the
trial balance ties and the projection agrees. Every balance check in the report
is satisfied by a ledger that now says something different from what was
posted. Only the hash chain notices.

A blunt control — an empty ledger — is rejected as evidence: nothing breaks,
and nothing is proven.

## Layout

```
src/types.ts        the vocabulary, as types
src/money.ts        exact integer minor units; no float anywhere
src/hash.ts         canonical content hashing and the chain
src/journal.ts      validation, as a pure function
src/ledger.ts       posting, reversal, period close, the change feed
src/balances.ts     accounting, current, pending and available, kept apart
src/projection.ts   the change stream consumer, with an inbox and checkpoints
src/invariants.ts   the nine invariants and the proof report
src/mutations.ts    the negative controls
src/scenario.ts     one synthetic ledger, built the same way every time
docs/SCHEMA.sql     the Spanner DDL, annotated — never executed
docs/MODEL.md       every way this model departs from the real product
docs/adr/           three decisions that were genuinely contested
results/            proof.json, mutations.json, audit-export.json, report.md
```

## Determinism

No `Date.now()` in `src/`. Every function that needs an instant takes it as a
parameter. `make determinism` re-runs the report and fails on a single changed
byte.
