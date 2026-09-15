# ADR-002: The safety argument is quorum intersection, not the absence of bugs

- Status: Accepted
- Date: 2026-09-15
- Article: 03

## Context

The lab claims that no operation is ever accepted twice, under partition,
regional loss, or concurrent submission in both regions. A claim of that shape
is usually supported by running many scenarios and observing no failures, which
establishes only that the tested scenarios did not fail.

## Decision

Implement the majority rule explicitly, and make the safety argument structural:
any two majorities of five voting replicas share at least one member, so a side
that can commit necessarily contains a replica that witnessed every prior
commit. Assert that intersection property directly in a test rather than
inferring it from scenario outcomes.

## Why this option

It converts the claim from empirical to structural. `T2` enumerates every
majority subset of the voting set and checks that all pairs intersect. Given
that, `doubleCommits` is empty for reasons that do not depend on which
scenarios were chosen.

The documented basis is two sentences. Replication: "The write is committed
when a majority of voting replicas (or write quorum) agree to commit the
write." Instance configurations: five voting replicas in a base multi-region
configuration, being two read-write regions of two replicas each plus a witness.

Negative control `N2` removes the majority requirement and shows both sides of
a partition accepting the same operation, which is what establishes that the
rule is doing the work rather than some accident of the model.

## Consequences

The model is a model of the documented quorum rule, not a reimplementation of
Spanner. It does not model TrueTime, commit wait, split boundaries, or schema.
The README and the article both say so.

## Conditions that would change the decision

A dual-region configuration has a different quorum shape — the region-types
page notes that for dual-region configurations the quorum requires two replicas
from both regions — and the intersection argument would have to be redone for
it.
