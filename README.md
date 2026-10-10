# gcp-transaction-correctness-lab

Runnable labs for transaction correctness on Google Cloud: retry safety,
idempotency, durable state, ledger invariants, event lineage, and
reconciliation.

Part of **Production Systems on Google Cloud**.

## Modules

| Module | Article | Proves |
|---|---|---|
| [`retry-safe-command-api`](modules/retry-safe-command-api) | 1 — When a Retry Becomes a Double Charge | One logical payment operation produces at most one money-moving effect, and an unknown outcome is resolved rather than guessed |
| [`queue-first-admission`](modules/queue-first-admission) | 2 — Black Friday Without a Meltdown | A bounded-admission controller refuses explicitly rather than admitting more protected work than downstream capacity can complete |
| [`regional-authority-lab`](modules/regional-authority-lab) | 3 — Active-Active Without Split-Brain | Every transactional write is ordered by one authority, or the application refuses rather than creating conflicting truth |
| [`financial-reconciliation`](modules/financial-reconciliation) | 7 — From Event Storm to Financial Truth | Delivery de-duplication, statement de-duplication and business finality are three different questions, and an accounting oracle keeps them apart |
| [`multi-layer-idempotency`](modules/multi-layer-idempotency) | 12 — Idempotency Is More Than a Header | One operation arriving through six boundaries yields one effect, and the suite records which of four layers stopped each duplicate |
| [`durable-money-state-machine`](modules/durable-money-state-machine) | 13 — State Machines That Survive Restarts | An optimistic version, a lease with an owner and a deadline, durable timers and correlated callbacks keep one money-movement entity correct across a restart |
| [`double-entry-ledger`](modules/double-entry-ledger) | 14 — How to Build a Double-Entry Ledger on Spanner | Balances rebuilt from append-only postings agree with the running totals, under concurrency, retry, correction and replay |
| [`outbox-inbox-replay`](modules/outbox-inbox-replay) | 17 — Transactional Outbox, Inbox, and Replay | An event-lineage verifier audits the chain from business change to consumer effect and reports what it is missing |
| [`dispute-deadline-workflow`](modules/dispute-deadline-workflow) | 21 — Chargebacks Are Deadline Systems | A versioned deadline and evidence-manifest engine with deterministic replay, where the deadline is a supplied parameter rather than an assumed constant |

Further modules are added as their articles are written. Each module is
self-contained and exposes the same entry point:

```bash
cd modules/<module>
make verify
```

## Principles

- **Count effects, not responses.** A service that double-charges still returns
  well-formed success responses. Every assertion here reconstructs what
  actually happened from an independent effect log.
- **Negative controls are mandatory.** Each module ships deliberately broken
  implementations that its harness must catch. A suite that cannot fail is not
  evidence.
- **Local by default.** Every module runs with no cloud project and no billing.
  Cloud profiles are opt-in, bounded, and carry a cost note.
- **Synthetic data only.** No production data, no real card numbers, no
  employer systems.

## License

Apache-2.0. See [LICENSE](LICENSE).
