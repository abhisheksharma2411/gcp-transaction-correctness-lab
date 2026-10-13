# The saga definition

**Generated from `src/saga.ts` by `scripts/generate.ts`. Do not edit.**

`make verify` fails if this file, `saga.json`, `results/saga.mmd` or either
of the two generated SVGs has drifted from the definition. That drift check
is the only reason to believe any of them.

## Definition version 1

6 steps across 5 participants. The pivot is `capture_payment`.

### Steps

| # | step | participant | does | compensation | role | attempts |
|---:|---|---|---|---|---|---:|
| 1 | `reserve_stock` | inventory | holds the ordered units against the order id | `release_stock` | compensable | 3 |
| 2 | `authorize_payment` | payments | places a hold on the cardholder's funds | `void_authorization` | compensable | 3 |
| 3 | `book_shipment` | fulfilment | asks the carrier for a shipment and waits for the booking reference | `cancel_shipment` | compensable | 3 |
| 4 | `capture_payment` | payments | settles the held funds | — | **pivot** | 4 |
| 5 | `post_ledger_entry` | ledger | writes the order's accounting entry | — | retryable | 4 |
| 6 | `send_confirmation` | notifications | emails the customer their confirmation | — | retryable, irreversible | 4 |

### Why each step sits where it does

- **`reserve_stock`** — First because it is the cheapest refusal: an order that cannot be filled should not reach a payment provider.
- **`authorize_payment`** — A hold is the cleanest compensable money step: voiding it leaves no settled movement to reconcile.
- **`book_shipment`** — The only step whose answer arrives later. Its callback is the one that can turn up after the saga has started compensating.
- **`capture_payment`** — The pivot. A capture is technically refundable, and this saga still does not treat a refund as its compensation: a refund is a new business process with its own evidence, which Article 14 and Article 21 own.
- **`post_ledger_entry`** — After the pivot, so it is retried rather than compensated. Article 14 owns what the entry contains.
- **`send_confirmation`** — Irreversible, and therefore deliberately last. An email sent before the pivot would be a lie the saga could not retract.

### The compensation chain

Reverse dispatch order: `cancel_shipment` → `void_authorization` → `release_stock`.

The chain walks the steps that were **dispatched**, not the steps that
answered. A step whose response never arrived has, as far as the
orchestrator can tell, happened.

### States

| state | terminal | left only by |
|---|---|---|
| `RUNNING` | no | — |
| `PIVOTED` | no | — |
| `COMPLETED` | yes | — |
| `COMPENSATING` | no | — |
| `COMPENSATED` | yes | — |
| `COMPENSATION_FAILED` | no | payments operations |
| `MANUAL_REPAIR` | no | payments operations |
| `CLOSED_MANUALLY` | yes | — |

### Transitions

| from | trigger | to | reason code |
|---|---|---|---|
| `RUNNING` | `step_failed` | `COMPENSATING` | `STEP_FAILED_BEFORE_PIVOT` |
| `RUNNING` | `cancel_requested` | `COMPENSATING` | `CANCELLED_BEFORE_PIVOT` |
| `RUNNING` | `pivot_committed` | `PIVOTED` | `PIVOT_COMMITTED` |
| `PIVOTED` | `forward_complete` | `COMPLETED` | `ALL_STEPS_DONE` |
| `PIVOTED` | `forward_exhausted` | `MANUAL_REPAIR` | `FORWARD_EXHAUSTED` |
| `COMPENSATING` | `compensations_complete` | `COMPENSATED` | `ALL_COMPENSATIONS_DONE` |
| `COMPENSATING` | `compensation_exhausted` | `COMPENSATION_FAILED` | `COMPENSATION_EXHAUSTED` |
| `COMPENSATION_FAILED` | `operator_retried` | `COMPENSATING` | `OPERATOR_RETRY` |
| `COMPENSATION_FAILED` | `operator_closed` | `CLOSED_MANUALLY` | `OPERATOR_CLOSED_COMPENSATION` |
| `MANUAL_REPAIR` | `operator_resumed` | `PIVOTED` | `OPERATOR_RESUME` |
| `MANUAL_REPAIR` | `operator_closed` | `CLOSED_MANUALLY` | `OPERATOR_CLOSED_FORWARD` |

### Why each transition exists

- **`RUNNING` --`step_failed`--> `COMPENSATING`** — A compensable step was refused or exhausted its attempts, so every durable effect recorded so far has to be undone in reverse order.
- **`RUNNING` --`cancel_requested`--> `COMPENSATING`** — A cancellation that arrives while the saga is still compensable is accepted and runs the same compensation chain a failure would.
- **`RUNNING` --`pivot_committed`--> `PIVOTED`** — The pivot step has a durable effect the business has decided not to undo. From here the saga can only go forward.
- **`PIVOTED` --`forward_complete`--> `COMPLETED`** — Every step after the pivot has a recorded effect.
- **`PIVOTED` --`forward_exhausted`--> `MANUAL_REPAIR`** — A step after the pivot ran out of attempts. Compensating is not available, so the saga stops and names an owner.
- **`COMPENSATING` --`compensations_complete`--> `COMPENSATED`** — Every recorded effect has a matching compensation record at the participant that produced it.
- **`COMPENSATING` --`compensation_exhausted`--> `COMPENSATION_FAILED`** — A compensation ran out of attempts. The saga does not loop on it; it stops with the chain half-run and raises it.
- **`COMPENSATION_FAILED` --`operator_retried`--> `COMPENSATING`** — An operator resumes the chain where it stopped. It restarts no compensation that already has a record.
- **`COMPENSATION_FAILED` --`operator_closed`--> `CLOSED_MANUALLY`** — An operator closes a saga that cannot be compensated automatically, leaving the effects that remain visible rather than claiming they are gone.
- **`MANUAL_REPAIR` --`operator_resumed`--> `PIVOTED`** — An operator returns a committed saga to the forward path. The cursor is unchanged, so the repair resumes rather than replays.
- **`MANUAL_REPAIR` --`operator_closed`--> `CLOSED_MANUALLY`** — An operator accepts a committed saga as finished without its remaining steps, which is a business decision and is recorded as one.

### Verification

| check | result | detail |
|---|---|---|
| `exactly-one-pivot` | PASS | pivot is capture_payment |
| `nothing-after-the-pivot-is-compensated` | PASS | every step after the pivot is retried, not undone |
| `irreversible-steps-sit-after-the-pivot` | PASS | no irreversible effect is produced while the saga can still be undone |
| `step-names-unique` | PASS | 6 distinct steps |
| `every-state-reachable` | PASS | all states have an inbound transition |
| `terminal-states-are-sinks` | PASS | nothing leaves a terminal state |
| `stopped-states-name-an-owner` | PASS | every state only an operator can leave names the operator |

---

## Definition version 2

6 steps across 5 participants. The pivot is `capture_payment`.

### Steps

| # | step | participant | does | compensation | role | attempts |
|---:|---|---|---|---|---|---:|
| 1 | `reserve_stock` | inventory | holds the ordered units against the order id | `release_stock` | compensable | 3 |
| 2 | `authorize_payment` | payments | places a hold on the cardholder's funds | `void_authorization` | compensable | 3 |
| 3 | `schedule_delivery` | fulfilment | books a delivery slot with the replacement carrier | `release_slot` | compensable | 3 |
| 4 | `capture_payment` | payments | settles the held funds | — | **pivot** | 4 |
| 5 | `post_ledger_entry` | ledger | writes the order's accounting entry | — | retryable | 4 |
| 6 | `send_confirmation` | notifications | emails the customer their confirmation | — | retryable, irreversible | 4 |

### Why each step sits where it does

- **`reserve_stock`** — First because it is the cheapest refusal: an order that cannot be filled should not reach a payment provider.
- **`authorize_payment`** — A hold is the cleanest compensable money step: voiding it leaves no settled movement to reconcile.
- **`schedule_delivery`** — The replacement for book_shipment. Same participant, different command, and a compensation under a different name.
- **`capture_payment`** — The pivot. A capture is technically refundable, and this saga still does not treat a refund as its compensation: a refund is a new business process with its own evidence, which Article 14 and Article 21 own.
- **`post_ledger_entry`** — After the pivot, so it is retried rather than compensated. Article 14 owns what the entry contains.
- **`send_confirmation`** — Irreversible, and therefore deliberately last. An email sent before the pivot would be a lie the saga could not retract.

### The compensation chain

Reverse dispatch order: `release_slot` → `void_authorization` → `release_stock`.

The chain walks the steps that were **dispatched**, not the steps that
answered. A step whose response never arrived has, as far as the
orchestrator can tell, happened.

### States

| state | terminal | left only by |
|---|---|---|
| `RUNNING` | no | — |
| `PIVOTED` | no | — |
| `COMPLETED` | yes | — |
| `COMPENSATING` | no | — |
| `COMPENSATED` | yes | — |
| `COMPENSATION_FAILED` | no | payments operations |
| `MANUAL_REPAIR` | no | payments operations |
| `CLOSED_MANUALLY` | yes | — |

### Transitions

| from | trigger | to | reason code |
|---|---|---|---|
| `RUNNING` | `step_failed` | `COMPENSATING` | `STEP_FAILED_BEFORE_PIVOT` |
| `RUNNING` | `cancel_requested` | `COMPENSATING` | `CANCELLED_BEFORE_PIVOT` |
| `RUNNING` | `pivot_committed` | `PIVOTED` | `PIVOT_COMMITTED` |
| `PIVOTED` | `forward_complete` | `COMPLETED` | `ALL_STEPS_DONE` |
| `PIVOTED` | `forward_exhausted` | `MANUAL_REPAIR` | `FORWARD_EXHAUSTED` |
| `COMPENSATING` | `compensations_complete` | `COMPENSATED` | `ALL_COMPENSATIONS_DONE` |
| `COMPENSATING` | `compensation_exhausted` | `COMPENSATION_FAILED` | `COMPENSATION_EXHAUSTED` |
| `COMPENSATION_FAILED` | `operator_retried` | `COMPENSATING` | `OPERATOR_RETRY` |
| `COMPENSATION_FAILED` | `operator_closed` | `CLOSED_MANUALLY` | `OPERATOR_CLOSED_COMPENSATION` |
| `MANUAL_REPAIR` | `operator_resumed` | `PIVOTED` | `OPERATOR_RESUME` |
| `MANUAL_REPAIR` | `operator_closed` | `CLOSED_MANUALLY` | `OPERATOR_CLOSED_FORWARD` |

### Why each transition exists

- **`RUNNING` --`step_failed`--> `COMPENSATING`** — A compensable step was refused or exhausted its attempts, so every durable effect recorded so far has to be undone in reverse order.
- **`RUNNING` --`cancel_requested`--> `COMPENSATING`** — A cancellation that arrives while the saga is still compensable is accepted and runs the same compensation chain a failure would.
- **`RUNNING` --`pivot_committed`--> `PIVOTED`** — The pivot step has a durable effect the business has decided not to undo. From here the saga can only go forward.
- **`PIVOTED` --`forward_complete`--> `COMPLETED`** — Every step after the pivot has a recorded effect.
- **`PIVOTED` --`forward_exhausted`--> `MANUAL_REPAIR`** — A step after the pivot ran out of attempts. Compensating is not available, so the saga stops and names an owner.
- **`COMPENSATING` --`compensations_complete`--> `COMPENSATED`** — Every recorded effect has a matching compensation record at the participant that produced it.
- **`COMPENSATING` --`compensation_exhausted`--> `COMPENSATION_FAILED`** — A compensation ran out of attempts. The saga does not loop on it; it stops with the chain half-run and raises it.
- **`COMPENSATION_FAILED` --`operator_retried`--> `COMPENSATING`** — An operator resumes the chain where it stopped. It restarts no compensation that already has a record.
- **`COMPENSATION_FAILED` --`operator_closed`--> `CLOSED_MANUALLY`** — An operator closes a saga that cannot be compensated automatically, leaving the effects that remain visible rather than claiming they are gone.
- **`MANUAL_REPAIR` --`operator_resumed`--> `PIVOTED`** — An operator returns a committed saga to the forward path. The cursor is unchanged, so the repair resumes rather than replays.
- **`MANUAL_REPAIR` --`operator_closed`--> `CLOSED_MANUALLY`** — An operator accepts a committed saga as finished without its remaining steps, which is a business decision and is recorded as one.

### Verification

| check | result | detail |
|---|---|---|
| `exactly-one-pivot` | PASS | pivot is capture_payment |
| `nothing-after-the-pivot-is-compensated` | PASS | every step after the pivot is retried, not undone |
| `irreversible-steps-sit-after-the-pivot` | PASS | no irreversible effect is produced while the saga can still be undone |
| `step-names-unique` | PASS | 6 distinct steps |
| `every-state-reachable` | PASS | all states have an inbound transition |
| `terminal-states-are-sinks` | PASS | nothing leaves a terminal state |
| `stopped-states-name-an-owner` | PASS | every state only an operator can leave names the operator |
