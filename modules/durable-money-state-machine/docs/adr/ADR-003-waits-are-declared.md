# ADR-003: Waiting conditions are declared, not implied

**Status:** accepted
**Date:** 2026-10-09

## Context

The core invariant for this machine says that every waiting condition has an
owner and a deadline. That is easy to write and easy to violate: a state gets
added, nothing moves it automatically, nobody notices, and six months later
there is a review queue with items in it from March.

The transition table alone cannot catch this. A state with no outgoing
transition that the system can take on its own initiative looks exactly like a
state that is waiting correctly.

## Decision

Split the specification in two.

- **Transitions** describe what may happen, and carry *one-shot actions*
  performed at the moment of transition.
- **Waits** describe what a state is waiting for while the entity sits in it:
  the owner, the deadline, and the mechanism that enforces it.

Declare which triggers are `autonomous` — the ones a worker can issue on its own
initiative. `timer_expired` is deliberately not one of them: a deadline is not
progress, it is the mechanism that notices the absence of progress.

Then verify, as a build-time check, that **every non-terminal state with no
autonomous outgoing transition declares a wait with an owner and a positive
deadline**, and that every declared timer deadline corresponds to a real
`timer_expired` row reaching the declared escalation state.

## Consequences

The standing conditions of a state become derivable from the state alone. A
worker that inherits a half-finished process does not need to know which
transition got the entity there; it asks what this state requires and makes it
so. Re-arming is safe because the timer is named after the thing it is a
deadline for and the fire time is computed from the recorded entry time, not
from the recovering worker's clock.

That is what makes crash recovery a function rather than a repair script, and
it is why a crash between committing `SUBMITTED` and calling the provider ends
in a state a human owns rather than in silence.

Two mechanisms are allowed, and the distinction is load-bearing:

- `timer` — a durable timer fires a trigger and the machine moves itself.
- `sweep` — nothing moves automatically; a periodic sweep raises it for a human.

Both are deadlines. Only one is a transition. Pretending otherwise is how review
queues acquire items nobody has looked at.

## Alternatives

**Put the deadline in the transition that enters the state.** Which is what most
implementations do, and it works until a second transition enters the same state
and forgets to arm the deadline. Declaring it on the state makes that
impossible.

**Give every waiting state a timer.** Rejected because it would be dishonest for
`MANUAL_REVIEW`: no timer should silently move a payout a human has not looked
at, and a timer that only raises an alert is a sweep with extra machinery.

**Leave it to a runbook.** A runbook is not a check.

## Cost

Two places to look instead of one, and a second kind of drift to police — which
is why `declared-waits-match-the-table` exists.

The check is also weaker than it sounds. It proves that a wait is declared, not
that the deadline is sensible, and not that anybody is actually reading the
sweep's output.

## Evidence

`tests/verify.test.ts`, checks
`every-waiting-state-has-an-owner-and-deadline` and
`declared-waits-match-the-table`, each shown to fail against a specification
broken in exactly the way it claims to detect. Scenario S22.
