| Scenario | Injected fault | Requests | Provider calls | Provider effects | Ledger postings | Open | Manual review | Invariant violations |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| sequential retries x100 | none | 100 | 1 | 1 | 1 | 0 | 0 | 0 |
| concurrent first requests x8 | none | 8 | 1 | 1 | 1 | 0 | 0 | 0 |
| provider succeeded, response lost, then 5 client retries | DROP_RESPONSE_AFTER_EFFECT | 5 | 1 | 1 | 1 | 0 | 0 | 0 |
| provider never received the request, reconciliation budget exhausted | TIMEOUT_BEFORE_EFFECT | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| event redelivered 3x plus a publish-side duplicate | at-least-once delivery | 1 | 1 | 1 | 1 | 0 | 0 | 0 |
| caller mints a new operation id on every retry (x25) | caller-side identity bug | 25 | 1 | 1 | 1 | 0 | 0 | 0 |
| retry arrives after the idempotency record was pruned | identity retention expiry | 2 | 1 | 1 | 1 | 0 | 0 | 0 |
