# retry-safe-command-api

A payment command API that stays correct when the provider's response is lost.

Companion lab for **Article 1 — When a Retry Becomes a Double Charge**
(*Failure-Driven Architecture on Google Cloud*).

```bash
make verify   # ~2s: type check, 18 tests, failure-injection matrix, schema check, secret scan, terraform validate
```

No Google Cloud project, no credentials, and no billing are needed for that
command.

## The invariant

> For one logical business operation, every legitimate retry converges on one
> durable outcome, and every externally visible monetary side effect is either
> prevented from duplicating or detected and reconciled.

## What makes this different from a normal test suite

Every assertion counts **provider effects and ledger postings**, never API
responses. A service that double-charges still returns two perfectly
well-formed success responses, so response-level assertions cannot detect the
bug this lab exists to catch.

Three independent sources are compared on every audit:

| Source | Question it answers |
|---|---|
| The provider simulator's effect log | How many times did money actually move? |
| `payment_operations` and `effect_claims` | What does the service believe happened? |
| `ledger_entries` | What did accounting record? |

`src/invariants.ts` fails the run when these disagree.

## Negative controls

A harness that never fails proves nothing. `tests/negative-control.test.ts`
asserts that deliberately broken implementations *are* caught:

| Control | Broken behaviour | Detected as |
|---|---|---|
| N1 | Fresh idempotency key generated inside the retry loop | 100 provider effects, 102 invariant violations |
| N2 | No durable operation record; relies entirely on the provider | Effect the caller cannot attribute |
| N3 | Consumer deduplicates on message id, not effect id | 2 ledger postings for 1 provider effect |
| N4 | Provider that ignores idempotency keys | 3 effects for 1 logical operation |

If these ever stop failing, the harness has stopped measuring anything.

## Layout

```text
src/
  types.ts            operation states and the durable record shape
  canonical.ts        request fingerprint, derived provider key, effect id
  store.ts            transactional store modelling Spanner's observable semantics
  provider.ts         deterministic provider simulator with an effect log
  payment-service.ts  claim -> provider call -> settle, plus reconciliation
  outbox.ts           outbox relay, at-least-once bus, deduplicating consumer
  invariants.ts       the business-effect audit
  spanner-rest.ts     minimal Spanner REST client, used only by the emulator tests
  app.ts              wiring
tests/
  conformance.test.ts       14 tests: the design behaves
  negative-control.test.ts   4 tests: the harness detects breakage
  spanner-emulator.test.ts   4 tests: the schema behaves, on the real engine
infra/
  schema.sql          Spanner DDL, applied to the emulator by `make emulator-up`
  main.tf             opt-in bounded cloud profile
  COST.md             read before applying anything
docs/
  provider-contracts.md   Stripe, PayPal and AWS compared, with links
  adr/                    three architecture decision records
```

## The two stores

`InMemoryTransactionalStore` models the **observable** semantics of a Spanner
read-write transaction: serializable isolation, read-set conflict detection,
and abort-and-retry. It does not model TrueTime, replication, commit latency,
or mutation limits. It exists so the conformance suite is deterministic and
runs with no cloud project.

Because a model can be wrong in the same direction as the code that uses it,
`tests/spanner-emulator.test.ts` checks the two schema properties the design
actually leans on against the real engine:

- a `UNIQUE` index refuses a second live operation for one order;
- a generated column that becomes NULL removes the row from a `NULL_FILTERED`
  index, which is how a declined attempt releases the order.

```bash
make emulator-up     # docker + schema
make emulator-test   # 4 tests
make emulator-down
```

### Two documented emulator differences you will hit

- The emulator rejects the duplicate but reports `INTERNAL: failed to marshal
  error message`. Assert on committed state, not on error text. Google
  documents that emulator error messages may differ from production.
- The emulator locks the entire database for a read-write transaction, so it
  cannot exercise true concurrency. Concurrent-duplicate coverage lives in the
  local suite instead.

## Why an outbox rather than Spanner change streams

Change streams are a real alternative, and a good one: Spanner writes the data
change record inside the same transaction as the data change, which gives the
same atomicity the outbox table gives here. The outbox is used because it keeps
the lab dependency-free and makes the publish-then-mark failure window visible
in code, which is the point being taught. Change streams belong in Article 17.

## Cloud deployment

`infra/` is opt-in and not part of `make verify`. **Read `infra/COST.md`
first**: a Spanner instance bills continuously from creation and the smallest
unit is 100 processing units. Apply, run the experiment, destroy the same day.

## Safety

- Synthetic data only. No real card numbers, no real credentials, no employer
  endpoints.
- `make verify` runs a secret scan that also flags any Luhn-valid 13-to-19
  digit sequence, so a real PAN fails the build before it reaches a branch.
- The default Compute Engine service account is deliberately not used; the
  Terraform creates separate user-managed identities for the API and the
  reconciler.

## Requirements

Node 22.18 or newer (24+ recommended) for native TypeScript type stripping. No
runtime dependencies. `npm install` is optional and only adds TypeScript for
`make typecheck`; every other target works without it. Docker and Terraform are
optional and their targets report themselves as skipped when absent.

## License

Apache-2.0.
