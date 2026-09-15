# ADR-002: The contention curve is an assumption, and is labelled as one

- Status: Accepted
- Date: 2026-09-14
- Article: 02

## Context

The article's most useful claim is that past some point, adding capacity to the
elastic tier stops helping and starts hurting the constrained one. Demonstrating
that requires a model of how service time degrades with concurrency.

No public Google Cloud document publishes such a curve for Spanner, and this
lab does not measure one.

## Decision

Model contention as a linear penalty above a knee:

```text
effectiveService = baseService * (1 + contentionPerUnit * max(0, running - knee))
```

Default `contentionPerUnit` to **zero**, so the headline comparison between
bounded and open-loop admission does not depend on the model at all. Turn it on
only for the envelope sweep, and label every figure it produces as a model
output.

## Why this option

Separating the two claims keeps the strong one clean.

- "Bounded admission converts unbounded latency growth into bounded latency
  plus explicit rejection" needs no contention model. Experiments E1 through E9
  run with the coefficient at zero.
- "There is a point past which more instances make things worse" needs one, and
  the honest thing is to say that its slope is assumed, show the sweep at two
  coefficients, and let the reader substitute their own measurement.

What the sweep supports is the existence and shape of a knee, not its location
in anyone's production system.

## Consequences

The article must never present envelope figures as measurements of Spanner,
Cloud Run, or any other product. The results file carries the warning, the
sweep table carries it, and the article carries it.

## Conditions that would change the decision

If the reader measures their own dependency, the coefficient becomes an input
and the envelope becomes a real planning tool for that system specifically.
This is the intended use.
