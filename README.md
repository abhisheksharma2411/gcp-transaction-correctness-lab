# gcp-transaction-correctness-lab

Runnable labs for transaction correctness on Google Cloud: retry safety,
idempotency, durable state, ledger invariants, event lineage, and
reconciliation.

Part of **Production Systems on Google Cloud**.

## Modules

| Module | Article | Proves |
|---|---|---|
| [`retry-safe-command-api`](modules/retry-safe-command-api) | 1 — When a Retry Becomes a Double Charge | One logical payment operation produces at most one money-moving effect, and an unknown outcome is resolved rather than guessed |

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
