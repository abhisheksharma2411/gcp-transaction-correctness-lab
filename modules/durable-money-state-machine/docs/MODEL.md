# What this model is not

Every way the module departs from real Google Cloud behaviour, listed without
flattery. If you are deciding whether a result here transfers to a system you
operate, read this before the README.

The module is a single-process, in-memory, deterministic simulation. It creates
no cloud resources, authenticates to nothing, and reaches no network. Nothing in
it has been run against Cloud Run, Spanner, Cloud Tasks, Workflows, Eventarc or
Pub/Sub.

---

## The store

| | the model | the real thing |
|---|---|---|
| storage | a `Map` in one process | Spanner or Cloud SQL |
| atomicity | a single assignment | a read-write transaction |
| concurrency | sequential calls in one thread | genuine interleaving across instances |
| reads | always current | subject to the chosen staleness |

**The optimistic version check is modelled, not demonstrated.** `apply` refuses
a stale `expectedVersion`, and a test drives two commands carrying the same
version. But both commands run on one thread, one after the other. A real
implementation has to make the read-compare-write atomic — in Spanner that is one
read-write transaction, and Spanner's own documentation notes that such a
transaction may be retried and that "Spanner might execute a transaction's
operations multiple times internally". None of that is exercised here.

**The history is an array on the entity.** In Spanner it would be an interleaved
child table, and the ordering question would be real. The module assigns a dense
sequence number precisely because a commit timestamp cannot be relied on for
ordering on its own: Spanner's documentation states that commit timestamp
"values are not guaranteed to be unique" and that "transactions that write to
non-overlapping sets of fields might have the same timestamp." The module does
not store a commit timestamp at all; `atMs` is supplied by the caller.

**No hot-key or transaction-size behaviour.** A payout's history grows without
bound in the model. In a real schema the history is the row set most likely to
cause a problem, and the module says nothing useful about that.

---

## The lease

**The lease is a field, written non-atomically with respect to the transition.**
`Runtime.step` claims the lease, writes it, and then applies the transition as a
second write. A real implementation must claim and act in one transaction, or
two workers can both observe an expired lease and both claim it. The module
cannot produce that interleaving and therefore cannot demonstrate that it is
handled.

**Clock skew does not exist here.** Every participant reads the same `nowMs`
argument. Lease expiry across machines depends on clocks that disagree, and the
usual mitigation — treat the lease as expired only some margin after its stated
expiry — is not modelled.

**The lease TTL of five minutes and the review deadline of one day are made up.**
They are not recommendations. The right values depend on how long a step takes,
how long a provider realistically needs, and how quickly a human is expected to
look.

---

## The timers

Modelled on Cloud Tasks, and the following are kept:

- delivery is at least once, and the module can deliver a timer twice;
- a task name deduplicates, and a repeat create is refused;
- a used name is not immediately reusable.

Not modelled:

- **Rate limits, queue backlogs and dispatch concurrency.** The queue here
  delivers everything that is due, instantly, in order.
- **The real deduplication window.** Cloud Tasks documents that a deleted or
  executed task's ID "can take up to 24 hours (or 9 days if the task's queue was
  created using a queue.yaml or queue.xml)" to become reusable. The model keeps
  used names forever, which is stricter than the platform and therefore hides
  the failure mode where a name becomes reusable sooner than you expected.
- **`dispatchDeadline` behaviour.** The module treats a worker as either
  finishing or crashing. Cloud Tasks documents something more awkward: the
  deadline cancels the *request*, and "whether the worker stops processing
  depends on the worker. For example, if the worker is stuck, it may not react
  to cancelled requests." A real deployment can have the queue retry while the
  original worker is still running. The lease is the module's answer to that,
  but the module cannot stage the situation.
- **Task-name hashing.** The documentation warns that sequential task IDs
  "causes an increase in latency and error rates in all task commands" and
  recommends hashed strings. The module's names are human-readable, because it
  has no queue to degrade.

---

## The orchestrator comparison

`EngineBackedDriver` is a caricature with one honest property: it keys state by
execution rather than by business entity, and its executions age out.

- The retention window is modelled as 90 days because Workflows documents a
  90-day limit on "an execution's history and results". Nothing else about
  Workflows is modelled — not its syntax, not its steps limit, not its 512 KB
  data limit, not its connectors, not its retry policies.
- `UNAVAILABLE` is borrowed as a concept, not implemented. Workflows' executions
  API documents a state whose description is "Execution data is unavailable."
  The driver returns `null`.
- **The comparison is rigged in one direction and fair in another.** It is
  rigged because a real Workflows deployment would normally write business state
  to a database as well, so the "no answer" column is not what a competent
  system looks like. It is fair because it isolates the question that matters:
  if the only record of the process is the execution, the answer has an expiry
  date.

---

## The provider

`ProviderSimulator` deduplicates on nothing and records every submission as a
separate event. That is deliberate — it means a crash scenario that still
produces one submission demonstrates that the *recorded state* prevented the
second one, rather than that a deduplication table absorbed it.

A real provider adapter should also carry an idempotency key, and that layer is
the subject of a different article. The module is therefore less safe than a
real implementation should be, in a way that makes the thing it is measuring
visible.

Also not modelled:

- partial or ambiguous provider responses beyond the three lookup answers;
- authentication, rate limits, or provider-side outages;
- a provider that distinguishes "never received" from "no answer yet". The model
  reports both as indeterminate, which is the conservative reading.

---

## Cloud Run

Nothing about Cloud Run is implemented. The crash points are an abstraction over
a class of events that includes instance shutdown, and the shape of that event
is taken from the container contract: Cloud Run sends `SIGTERM` "indicating the
start of a 10 second period before the actual shutdown occurs, at which point
Cloud Run sends a SIGKILL signal."

The module does not model:

- concurrency within an instance, or several instances handling the same entity;
- startup latency, cold starts, or minimum instances;
- the request timeout, which in a real deployment interacts with the lease TTL
  in ways nothing here explores.

---

## The state machine itself

**One entity.** Every scenario concerns one payout. Coordinating several
independently transactional participants, and compensating them when one fails,
is a different problem and is not attempted.

**No money is modelled.** There are no balances, no postings, no double entry.
`SETTLED` is a label; nothing in the module checks that anything adds up.
Accounting is a separate subject.

**The amounts, thresholds and deadlines are synthetic.** `REVIEW_THRESHOLD_MINOR`
is 500,000 minor units because a number was needed.

**The specification is small enough to verify exhaustively.** Eight states and
sixteen rows. The reachability and termination checks are breadth-first searches
over a graph with eight nodes. They stay cheap on a machine of this size; they
are not a claim about what happens at a hundred states, and a hundred-state
business process is usually a sign that several entities have been merged into
one.

**Verification checks shape, not judgement.** Specification version 1 passes
every check in `src/verify.ts` and still records a guess as a terminal fact. This
is stated as a test, so that a green verification run is never read as a correct
business process.

---

## Determinism

No `Date.now()` and no `Math.random()` appear anywhere in `src/`; a test asserts
this by reading the source. Every function that needs the time takes it as a
parameter, and `make report` produces byte-identical output on re-run.

The cost is that nothing in the module can be timing-dependent, which is the
same thing as saying that nothing in the module can demonstrate a race.
