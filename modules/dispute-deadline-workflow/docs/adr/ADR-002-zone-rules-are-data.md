# ADR-002: Time-zone rules are pinned data, not an ambient property of the host

## Context

A deadline expressed as a local wall-clock time is not an instant until some
rule set converts it. Those rules change. The IANA Time Zone Database is
"updated periodically to reflect changes made by political bodies to time zone
boundaries, UTC offsets, and daylight-saving rules", and its release 2026e,
dated 2026-09-29, carries the change "Manitoba moves to permanent -05 on
2026-10-31."

A system that reads the host's database computes a deadline that depends on
when the host was last patched.

## Options considered

**A. Use the platform's database through `Intl.DateTimeFormat`.** Correct,
complete, maintained by somebody else, and free.

**B. Pin a table of transitions as data, versioned, and record the version with
every deadline.**

**C. Store only the resolved instant and discard the local expression.**

## Decision

B, with the resolved instant stored as well.

## Why this option

A is the right default for almost every program. It is wrong here for one
reason: the question a dispute system has to answer six months later is not
"what time is it" but "what deadline did we compute, and why". Under A the
answer changes when the host is patched, and it changes silently, because
nothing records which rules were in force. Re-deriving a past deadline to check
it would produce a different number and no explanation.

C is tempting and insufficient. Storing the instant makes the deadline stable
but throws away the reasoning, so a dispute about whether the deadline was
calculated correctly cannot be settled.

B costs the most and is the only one that makes a deadline reproducible. The
table is small, it is versioned, and `DeadlineDecision.zoneTableVersion` is
recorded on every case.

## Managed-service guarantees used

None. This decision is specifically about *not* depending on a guarantee the
runtime offers.

## Application responsibilities that remain

Keeping the table current, which is real work and is the main cost of this
decision. `scripts/tz-drift.ts` exists to make the gap visible: it compares the
pinned table with the host's and prints the differences. It is deliberately not
part of `make verify`, because a newer host is not a build failure.

## Consequences

The module's zone tables are synthetic and bounded; `docs/MODEL.md` says so at
length. Two versions are shipped so that the same notification can be shown
producing two different deadlines, which is the argument made concrete.

## Conditions that would change this decision

A runtime that exposed the version of its own time-zone database, and allowed
pinning it, would make A acceptable: the version is the part that matters, not
who maintains the data.
