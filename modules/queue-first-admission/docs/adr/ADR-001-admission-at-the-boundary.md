# ADR-001: The admission decision belongs at the boundary of protected work

- Status: Accepted
- Date: 2026-09-14
- Article: 02

## Context

Three Google Cloud products offer something that looks like admission control:

- Cloud Armor rate-based rules, which "limit the rate of requests to a defined
  maximum" at the edge;
- Cloud Tasks queue rate limits, via `max_dispatches_per_second`;
- Pub/Sub subscriber flow control, which "lets the subscriber regulate the rate
  at which messages are ingested."

It is tempting to pick one and call the problem solved.

## Decision

Use edge rate limiting for abuse and crude protection, use flow control to stop
a subscriber drowning itself, but make the *business* admission decision in the
service, immediately in front of the constrained dependency, using a measured
drain rate.

## Why this option

Each of the alternatives is the wrong shape for the job.

**Cloud Armor** counts requests per client over an interval. It cannot know
that inventory for one SKU is nearly exhausted, that a particular tenant is
already at its share, or that the database has slowed down. It is a blunt
instrument aimed at a different threat.

**Cloud Tasks rate limits are a shaping device, not a ceiling.** Its own
configuration page says so twice: an uneven load "can allow the number of
tokens in the bucket to grow significantly, which can lead to bursts of
processing," and "your queue might experience an actual dispatch rate that
exceeds your `max_dispatches_per_second` rate." A control that may be exceeded
is not a guarantee, and `max_burst_size` "is calculated by the system," not by
the owner.

**Pub/Sub flow control protects the subscriber, not the dependency.** It stops
one client pulling more than it can hold. It says nothing about how many
clients there are, which is precisely the variable that autoscaling changes.

The decision that matters is business-shaped: given what is already queued, how
fast we are actually draining it, and who is asking, can we promise this caller
an answer inside the time we advertise? Only the service knows all three.

## Consequences

The controller must be co-located with the worker pool so it can measure drain
rate rather than assume it. That measurement is what makes it adapt to a slow
dependency (experiment E4) rather than discovering the problem through customer
complaints.

It also means every instance runs its own controller. The lab models one
logical admission point; a real deployment must decide whether per-instance
limits are summed centrally or divided statically, and that choice belongs in
the article's "what this does not solve" section.

## Conditions that would change the decision

If the constrained dependency published a reliable, low-latency capacity
signal, the controller could consume that instead of estimating from observed
service time.
