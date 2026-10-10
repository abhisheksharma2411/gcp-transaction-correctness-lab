# outbox-inbox-replay

A transactional outbox, a consumer inbox, a dead-letter path, a bounded replay
tool — and an **event-lineage verifier** that audits a run of all of them and
reports what the chain from business change to consumer effect is missing.

Companion lab for Article 17, *Transactional Outbox, Inbox, and Replay on
Google Cloud*.

No cloud project. No credentials. No network. `make verify` runs everything.

## The idea

A service changes durable state and publishes an event about it. Those are two
writes to two systems and there is no transaction across them, so one of three
things is true:

| strategy | what survives a crash in the window |
|---|---|
| publish after commit | the change, without the event |
| publish before commit | the event, without the change |
| outbox | both, and sometimes the event twice |

Only the third failure is one a consumer can absorb. Here is the module running
exactly that comparison:

| crash point | strategy | committed | events on topic | protected effects | findings |
|---|---|---:|---:|---:|---|
| after-commit-before-publish | `publish-after-commit` | 1 | 0 | 0 | `L01_MISSING_EVENT` |
| before-commit | `publish-before-commit` | 0 | 1 | 2 | `L02_PHANTOM_EVENT` |
| after-commit-before-publish | `outbox` | 1 | 1 | 2 | none |
| after-publish-before-checkpoint | `outbox` | 1 | **2** | 2 | none |

Two messages, one effect. That last row is the outbox's honest failure mode and
the reason the consumer needs an inbox.

## The contribution: the lineage verifier

Ten findings, each with a code, because "the events look fine" is not a result
anybody can act on.

| code | what it means |
|---|---|
| `L01_MISSING_EVENT` | a committed change with no event |
| `L02_PHANTOM_EVENT` | an event with no committed change |
| `L03_UNPUBLISHED` | an event captured and never published |
| `L04_UNDELIVERED` | an event published and never delivered to a consumer that needs it |
| `L05_DUPLICATE_PROTECTED_EFFECT` | one protected effect applied twice |
| `L06_UNHANDLED_SCHEMA_VERSION` | a version nobody handled and nobody routed |
| `L07_ORPHAN_EFFECT` | an effect with no delivery behind it |
| `L08_ORDER_VIOLATION` | one aggregate's effects applied in decreasing sequence order |
| `L09_REPLAY_DIVERGENCE` | a replay that changed the effect set |
| `L10_DEAD_LETTER_UNRESOLVED` | a dead-lettered event nobody recorded a decision about |

It reads the **trace** and the event catalogue — the records the system chose
to write — and nothing else. A mechanism that works but leaves no record is
therefore invisible to it, which is a limitation and also the point: it is the
same restriction an auditor has.

## The controls

The verifier reported zero findings on the first correct run it was pointed at,
which proves nothing when one author writes both the mechanisms and the checks.
So every code is provoked by a named defect, and each control must produce its
stated codes and no others:

| control | expected |
|---|---|
| `publish-after-commit` | `L01` |
| `publish-before-commit` | `L02` |
| `relay-never-runs` | `L03`, `L09` |
| `consumer-never-drains` | `L04` |
| `no-guards` | `L05`, `L08` |
| `ignore-schema-version` | `L06` |
| `manual-repair-off-the-record` | `L07` |
| `no-sequence-guard` | `L08` |
| `no-dead-letter-repair` | `L10` |

A tenth control breaks four things at once and is **required to be rejected as
too blunt**: "I broke it and the checker complained" is not evidence that any
particular check does work.

## Four guards, and which one is actually load-bearing

A consumer here has four, and the controls show each one carrying the weight
once the ones above it are removed:

```
schema version  ->  inbox (event id)  ->  sequence position  ->  effect ledger
```

In the standard run the inbox catches every duplicate and the three below it
never fire. Remove the inbox and the sequence position catches the replay.
Remove both and the effect ledger does. Remove all three and `L05` appears.
The effect ledger is keyed on the aggregate's position rather than on the event
id for exactly this reason — see [ADR-002](docs/adr/ADR-002-effect-identity-not-event-identity.md).

## Layout

```
src/types.ts        the envelope, the outbox row, the trace, the findings
src/identity.ts     event identity, effect identity, ordering key
src/source.ts       the three capture strategies, side by side
src/relay.ts        claim under lease, publish, checkpoint -- and the gap between
src/broker.ts       a Pub/Sub-compatible adapter: ordering, dead letter, seek
src/consumer.ts     inbox, sequence position, effect ledger, schema routing
src/replay.ts       bounded scope, dry run, republication from the log
src/projection.ts   a read model rebuilt from the event log
src/lineage.ts      the verifier
src/controls.ts     the standard run and every negative control
tests/              73 tests
scripts/            report, lineage gate, replay CLI
docs/               MODEL.md and four ADRs
```

## Running it

```
make verify     # strict typecheck, 73 tests, report, lineage gate, secret scan
make report     # regenerate every table above
make lineage    # the verifier plus every control
node scripts/replay.ts --help
node scripts/replay.ts --aggregate ord-b          # dry run
node scripts/replay.ts --aggregate ord-b --apply  # publish
```

Node 22.18 or newer. `npm install` is optional and only enables the typecheck.

## Honesty notes

- **There is no concurrency.** One process, one thread. The lease is a field,
  not a lock, and the inbox-and-effect pair is atomic here because nothing else
  is running. [`docs/MODEL.md`](docs/MODEL.md) lists every simplification, and
  there are many.
- **The dead-letter count is exact here and approximate at the platform.**
  Pub/Sub's documentation says the maximum delivery attempts figure is
  approximate and that the tracked count can reset to zero. Nothing here should
  be read as a promise about when a message is forwarded.
- **Seek is instant here and eventually consistent at the platform.** A real
  replay has an overlap window this module never produces.
- **The verifier has never been pointed at a real system.** Its portability —
  that the same checks run against a trace assembled from logs — is an argument
  about its interface, not a result.
