# State machine

**Generated from `src/spec.ts` by `scripts/generate.ts`. Do not edit.**

`make verify` fails if this file drifts from the specification, which is the
only reason to trust it.

## Specification version 2

Initial state `DRAFT`. Terminal states `SETTLED`, `DECLINED`, `CANCELLED`.

### Transitions

| from | trigger | to | guards | reason code |
|---|---|---|---|---|
| `DRAFT` | `authorize` | `AUTHORIZED` | `actor-is-service`<br>`amount-within-auto-limit` | `AUTO_APPROVED_WITHIN_LIMIT` |
| `DRAFT` | `authorize` | `MANUAL_REVIEW` | `actor-is-service`<br>`amount-above-auto-limit` | `ROUTED_TO_REVIEW_OVER_LIMIT` |
| `DRAFT` | `cancel` | `CANCELLED` | — | `CANCELLED_BEFORE_AUTHORIZATION` |
| `AUTHORIZED` | `submit` | `SUBMITTED` | `actor-is-service` | `SUBMITTED_TO_PROVIDER` |
| `AUTHORIZED` | `cancel` | `CANCELLED` | — | `CANCELLED_BEFORE_SUBMISSION` |
| `SUBMITTED` | `callback_settled` | `SETTLED` | `actor-is-provider`<br>`callback-token-matches` | `PROVIDER_CONFIRMED_SETTLEMENT` |
| `SUBMITTED` | `callback_declined` | `DECLINED` | `actor-is-provider`<br>`callback-token-matches` | `PROVIDER_DECLINED` |
| `SUBMITTED` | `timer_expired` | `RECONCILING` | — | `CALLBACK_DEADLINE_PASSED` |
| `RECONCILING` | `lookup_settled` | `SETTLED` | `actor-is-service` | `RESOLVED_SETTLED_BY_LOOKUP` |
| `RECONCILING` | `lookup_declined` | `DECLINED` | `actor-is-service` | `RESOLVED_DECLINED_BY_LOOKUP` |
| `RECONCILING` | `lookup_indeterminate` | `MANUAL_REVIEW` | `actor-is-service` | `LOOKUP_INDETERMINATE` |
| `RECONCILING` | `callback_settled` | `SETTLED` | `actor-is-provider`<br>`callback-token-matches` | `LATE_CALLBACK_ACCEPTED` |
| `RECONCILING` | `callback_declined` | `DECLINED` | `actor-is-provider`<br>`callback-token-matches` | `LATE_CALLBACK_ACCEPTED` |
| `MANUAL_REVIEW` | `review_approve` | `AUTHORIZED` | `actor-is-operator`<br>`reviewer-is-not-initiator`<br>`within-reviewer-limit` | `REVIEW_APPROVED` |
| `MANUAL_REVIEW` | `review_reject` | `CANCELLED` | `actor-is-operator`<br>`reviewer-is-not-initiator` | `REVIEW_REJECTED` |
| `MANUAL_REVIEW` | `cancel` | `CANCELLED` | `actor-is-service` | `CANCELLED_IN_REVIEW` |

### Why each row exists

- **`DRAFT` --`authorize`--> `AUTHORIZED`** — Small enough to approve without a human. No external effect yet.
- **`DRAFT` --`authorize`--> `MANUAL_REVIEW`** — Over the limit. Review is a route to approval, never an exemption from it.
- **`DRAFT` --`cancel`--> `CANCELLED`** — Nothing has been promised to anyone, so cancellation is free.
- **`AUTHORIZED` --`submit`--> `SUBMITTED`** — The only transition that creates an external monetary effect.
- **`AUTHORIZED` --`cancel`--> `CANCELLED`** — Still free: authorization is an internal fact.
- **`SUBMITTED` --`callback_settled`--> `SETTLED`** — The token is what makes this callback this payout's callback.
- **`SUBMITTED` --`callback_declined`--> `DECLINED`** — A decline is an answer, and an answer is a success for the state machine.
- **`SUBMITTED` --`timer_expired`--> `RECONCILING`** — The deadline passing is a fact about our waiting, not a fact about the money.
- **`RECONCILING` --`lookup_settled`--> `SETTLED`** — The provider knew all along; the callback was what went missing.
- **`RECONCILING` --`lookup_declined`--> `DECLINED`** — Same shape, opposite answer.
- **`RECONCILING` --`lookup_indeterminate`--> `MANUAL_REVIEW`** — Nobody can answer automatically, so the process acquires a human owner rather than a guess.
- **`RECONCILING` --`callback_settled`--> `SETTLED`** — A callback that arrives after the deadline is late, not invalid.
- **`RECONCILING` --`callback_declined`--> `DECLINED`** — The same allowance for the opposite answer.
- **`MANUAL_REVIEW` --`review_approve`--> `AUTHORIZED`** — Back to AUTHORIZED, never straight to a terminal state. Review grants permission to proceed, not an outcome.
- **`MANUAL_REVIEW` --`review_reject`--> `CANCELLED`** — Rejection needs the same separation of duty as approval and none of the amount authority.
- **`MANUAL_REVIEW` --`cancel`--> `CANCELLED`** — The requester may still withdraw a payout that has not been submitted.

### Waiting conditions

Every non-terminal state that nothing inside the system can move on its
own must name who it is waiting for and how long the wait may last.

| state | waits on | deadline | mechanism | escalates to |
|---|---|---:|---|---|
| `SUBMITTED` | payment-provider | 6h | timer | RECONCILING |
| `MANUAL_REVIEW` | payouts-operations | 24h | sweep | — |

### Forbidden pairs

73 of the 88 (state, trigger) combinations have no row.
An attempt at any of them is refused with `NO_SUCH_TRANSITION` if the entity is live,
or `TERMINAL` if it has finished.

### Verification

| check | result | detail |
|---|---|---|
| `every-state-reachable` | PASS | 8 states reachable from DRAFT |
| `every-state-can-terminate` | PASS | every state has a path to a terminal state |
| `terminal-states-are-sinks` | PASS | 3 terminal states have no outgoing transitions |
| `no-duplicate-rows` | PASS | 16 rows, all distinct |
| `guards-exist` | PASS | 8 guards defined |
| `every-waiting-state-has-an-owner-and-deadline` | PASS | every waiting state names an owner and a deadline |
| `declared-waits-match-the-table` | PASS | every timer deadline has a row and every row has a deadline |
| `reason-codes-unique-per-destination` | PASS | 15 reason codes, none spanning two source states |

---

## Specification version 1

Initial state `DRAFT`. Terminal states `SETTLED`, `DECLINED`, `CANCELLED`.

### Transitions

| from | trigger | to | guards | reason code |
|---|---|---|---|---|
| `DRAFT` | `authorize` | `AUTHORIZED` | `actor-is-service` | `AUTO_APPROVED` |
| `DRAFT` | `cancel` | `CANCELLED` | — | `CANCELLED_BEFORE_AUTHORIZATION` |
| `AUTHORIZED` | `submit` | `SUBMITTED` | `actor-is-service` | `SUBMITTED_TO_PROVIDER` |
| `AUTHORIZED` | `cancel` | `CANCELLED` | — | `CANCELLED_BEFORE_SUBMISSION` |
| `SUBMITTED` | `callback_settled` | `SETTLED` | `actor-is-provider`<br>`callback-token-matches` | `PROVIDER_CONFIRMED_SETTLEMENT` |
| `SUBMITTED` | `callback_declined` | `DECLINED` | `actor-is-provider`<br>`callback-token-matches` | `PROVIDER_DECLINED` |
| `SUBMITTED` | `timer_expired` | `RECONCILING` | — | `CALLBACK_DEADLINE_PASSED` |
| `RECONCILING` | `lookup_settled` | `SETTLED` | `actor-is-service` | `RESOLVED_SETTLED_BY_LOOKUP` |
| `RECONCILING` | `lookup_declined` | `DECLINED` | `actor-is-service` | `RESOLVED_DECLINED_BY_LOOKUP` |
| `RECONCILING` | `lookup_indeterminate` | `DECLINED` | `actor-is-service` | `LOOKUP_INDETERMINATE_TREATED_AS_DECLINE` |

### Why each row exists

- **`DRAFT` --`authorize`--> `AUTHORIZED`** — Version 1 approved every amount. This is the defect version 2 fixes.
- **`DRAFT` --`cancel`--> `CANCELLED`** — Unchanged in version 2.
- **`AUTHORIZED` --`submit`--> `SUBMITTED`** — Unchanged in version 2.
- **`AUTHORIZED` --`cancel`--> `CANCELLED`** — Unchanged in version 2.
- **`SUBMITTED` --`callback_settled`--> `SETTLED`** — Unchanged in version 2.
- **`SUBMITTED` --`callback_declined`--> `DECLINED`** — Unchanged in version 2.
- **`SUBMITTED` --`timer_expired`--> `RECONCILING`** — Unchanged in version 2.
- **`RECONCILING` --`lookup_settled`--> `SETTLED`** — Unchanged in version 2.
- **`RECONCILING` --`lookup_declined`--> `DECLINED`** — Unchanged in version 2.
- **`RECONCILING` --`lookup_indeterminate`--> `DECLINED`** — Version 1 guessed. Recording a guess as a terminal fact is what version 2 stops doing.

### Waiting conditions

Every non-terminal state that nothing inside the system can move on its
own must name who it is waiting for and how long the wait may last.

| state | waits on | deadline | mechanism | escalates to |
|---|---|---:|---|---|
| `SUBMITTED` | payment-provider | 6h | timer | RECONCILING |

### Forbidden pairs

67 of the 77 (state, trigger) combinations have no row.
An attempt at any of them is refused with `NO_SUCH_TRANSITION` if the entity is live,
or `TERMINAL` if it has finished.

### Verification

| check | result | detail |
|---|---|---|
| `every-state-reachable` | PASS | 7 states reachable from DRAFT |
| `every-state-can-terminate` | PASS | every state has a path to a terminal state |
| `terminal-states-are-sinks` | PASS | 3 terminal states have no outgoing transitions |
| `no-duplicate-rows` | PASS | 10 rows, all distinct |
| `guards-exist` | PASS | 8 guards defined |
| `every-waiting-state-has-an-owner-and-deadline` | PASS | every waiting state names an owner and a deadline |
| `declared-waits-match-the-table` | PASS | every timer deadline has a row and every row has a deadline |
| `reason-codes-unique-per-destination` | PASS | 10 reason codes, none spanning two source states |
