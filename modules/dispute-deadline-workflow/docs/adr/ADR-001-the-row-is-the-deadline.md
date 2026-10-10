# ADR-001: The durable row is the deadline; the timer is a prompt

## Context

A dispute deadline is commonly further out than thirty days. Cloud Tasks
publishes a system limit of "30 days from current date and time" as the
"Maximum amount of time in the future that a task can be scheduled", alongside
a "Maximum task retention" of 31 days, "The time between when a task is added
to a queue and when it is automatically deleted". The quotas page states that
"System limits can't be changed."

So the natural implementation -- create one task at the deadline when the case
opens -- cannot express a deadline more than a month away.

## Options considered

**A. A chain of renewal tasks.** Each task, on firing, schedules the next one
until the target is inside the horizon. Simple, uses only the queue, and needs
no scan.

**B. A durable due row plus a periodic sweep.** Every case carries its target
as a column. A scheduled job reads the rows and acts on the ones that are due.
No timer at all.

**C. Both: the row is authoritative, the timer is an optimisation.**

## Decision

C.

## Why this option

A alone fails in the characteristic way of this whole problem domain. If one
hop in the chain is not created -- a deploy during the window, a quota refusal,
an exception in the handler between acting and rescheduling -- the chain ends.
Nothing has failed loudly. There is no task to inspect, no error, no alert,
because the evidence of the missing timer is the absence of a row in a queue,
and queues do not report tasks that were never created. The case then sits
until somebody notices the money.

B alone is correct and wasteful: it means scanning every open case on every
interval regardless of whether anything is close to its target, and it couples
the latency of noticing to the sweep interval.

C keeps the correctness of B and most of the efficiency of A. The timer wakes
the system at roughly the right moment. The sweep is what guarantees the moment
is not missed. Crucially, the sweep reports its own scan count even when it
finds nothing, which turns "the deadline machinery is alive" into a positive
signal rather than an inference from silence.

## Cost and operational impact

The sweep is a repeated read over open cases. For the population sizes this
article discusses that is cheap; for a very large population it needs an index
on the target column and pagination, neither of which this module implements.
The renewal chain adds one task per thirty days per long-running case.

## Consequences

`DueRow` carries `internalTarget` as well as `deadline`, so the sweep can
distinguish cases that are still actionable from cases that are already lost.
`scheduleNext` returns a hop count, which is the number of independent chances
the chain has to break, and the report prints it.

## Conditions that would change this decision

If Cloud Tasks raised or removed the 30-day limit, option A would become
expressible for most windows -- and the argument against it would not change at
all, because the failure mode is the chain, not the horizon. A durable workflow
engine that guarantees a wait of arbitrary length, and that reports waits it has
lost, would be a real alternative.
