# durable-money-state-machine

An executable specification for one durable money-movement entity, plus the
things that make it survive a restart: an optimistic version, a lease with an
owner and a deadline, durable timers, correlated callbacks, and a transition
history you can replay.

Companion lab for Article 13 — *State Machines That Survive Restarts*.

```bash
make verify     # strict typecheck, 150 tests, report, drift check, secret scan
make report     # regenerate every table in the article
make generate   # rebuild the docs and the diagram source from src/spec.ts
make inspect    # print one payout's transition history
node scripts/inspect.ts --list
```

No cloud project, no credentials, no network.

## The one artifact

`src/spec.ts` is the specification. Everything downstream is generated from it
and the build fails if any of it drifts:

| generated | from | what it is |
|---|---|---|
| `docs/STATE_MACHINE.md` | `src/spec.ts` | the transition table, the waiting conditions, the verification results |
| `state-machine.json` | `src/spec.ts` | the machine-readable export |
| `results/state-machine.mmd` | `src/spec.ts` | a Mermaid state diagram |

`node scripts/generate.ts --check` is wired into `make verify`. Documentation
that nobody regenerates is worse than no documentation, because it is
confidently wrong.

## Two halves of the specification

**Transitions** say what may happen and carry one-shot actions.
**Waits** say what a state is waiting for while the entity sits in it — the
owner, the deadline, and whether a timer or a human-facing sweep enforces it.

A build-time check requires every non-terminal state that nothing can move on
its own initiative to declare a wait with an owner and a positive deadline. That
is the core invariant, made into a check rather than a promise. See ADR-003.

## What the report shows

Crash at each point of the one transition that moves money, then let recovery
and the deadline run:

| crash point | state recorded | final state | provider submissions |
|---|---|---|---:|
| `none` | SUBMITTED | SETTLED | 1 |
| `before-commit` | AUTHORIZED | SETTLED | 1 |
| `after-commit-before-actions` | SUBMITTED | **MANUAL_REVIEW** | **0** |
| `after-actions-before-ack` | SUBMITTED | SETTLED | 1 |

*Simulated result. Regenerate with `make report`.*

The third row is the one to read twice: the payout records a submission that
never happened, and the only thing that discovers it is the deadline.

Then the same lifecycle on two drivers running the same transition table, after
the orchestrator's retention window passes:

| driver | during the run | after the retention window |
|---|---|---|
| application-owned row | SUBMITTED | SUBMITTED |
| orchestration execution | SUBMITTED | **no answer** |

*Simulated result.*

## Verification

Eight static checks over the specification, run on every build:

```
every-state-reachable                          every state can be reached from DRAFT
every-state-can-terminate                      no non-terminal trap
terminal-states-are-sinks                      SETTLED has no way out
no-duplicate-rows                              no unreachable second row
guards-exist                                   no row names an undefined guard
every-waiting-state-has-an-owner-and-deadline  the core invariant
declared-waits-match-the-table                 a deadline fires into a real row
reason-codes-unique-per-destination            the history can explain itself
```

Four deliberately broken specifications confirm each check is doing something;
three of the four are caught by exactly one check.

**Verification checks shape, not judgement.** Specification version 1 passes
every check above and still records a guess as a terminal fact. There is a test
asserting that, so a green run is never read as a correct business process.

## Negative controls

Six runtime checks, each removed in turn, each required to lose a specific named
refusal:

| check removed | refusal lost |
|---|---|
| `no-terminal-check` | `TERMINAL` |
| `no-version-check` | `VERSION_CONFLICT` |
| `no-lease-check` | `LEASE_NOT_HELD` |
| `no-guards` | `GUARD_FAILED` |
| `no-callback-correlation` | `CALLBACK_UNCORRELATED` |
| `history-not-appended` | the append-only property |

A further control rejects any mutation blunt enough to silence the whole probe,
and one test guards the harness itself.

## Layout

```
src/spec.ts        the specification: transitions, guards, waits
src/machine.ts     one pure function; effects are returned, never performed
src/policy.ts      the two rules not in the table, and the mutations
src/lease.ts       claim, renew, release, sweep
src/timers.ts      durable timers modelled on Cloud Tasks
src/runtime.ts     store, provider, callbacks, crash injection, recovery
src/verify.ts      static verification of a specification
src/migrate.ts     version 1 to version 2, with a dry run
src/drivers.ts     application-owned state versus orchestration state
src/scenarios.ts   28 scenarios, run by both the tests and the report
docs/MODEL.md      every way this departs from real Google Cloud behaviour
docs/adr/          four decisions that were genuinely contested
```

## Honest limits

Read `docs/MODEL.md` in full. The short version:

- **Single-threaded.** The version check and the lease are modelled, not raced.
  No test here demonstrates that claim-and-act is atomic, because nothing here
  can interleave.
- **No money.** `SETTLED` is a label. Nothing checks that anything adds up.
- **One entity.** Coordinating several independently transactional participants,
  and compensating them, is a different problem and is not attempted.
- **The orchestrator comparison is deliberately narrow.** A real Workflows
  deployment would write business state to a database too; the comparison
  isolates the question of where the answer lives, and nothing else.
- **The thresholds and deadlines are invented.** They are not recommendations.
