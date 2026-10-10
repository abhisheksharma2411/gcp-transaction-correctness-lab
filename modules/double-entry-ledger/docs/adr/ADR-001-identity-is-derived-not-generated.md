# ADR-001 — Journal and posting identity is derived, not generated

**Status:** accepted
**Date:** 2026-10-09

## Context

The Spanner transaction documentation states that "Spanner might execute a
transaction's operations multiple times internally", and that the client
library "executes this function repeatedly until the transaction either commits
successfully or encounters an error that can't be" retried.

That has a direct consequence for a ledger. If the transaction body calls a
UUID generator, or reads a sequence, or asks for the current time, then attempt
two produces different values from attempt one. The mutations of attempt one
are discarded, so nothing is written twice in that run — but the moment two
executions can both reach a commit, by a client-side retry around the whole
operation rather than inside it, the primary key no longer recognises the
duplicate.

## Decision

`JournalId = "jnl_" + hash(ledgerId, businessRef)`, and
`PostingId = f(journalId, lineNumber)`.

No identifier in this module is generated. Every one is a function of content
the caller already chose.

## Alternatives considered

**`NEW_UUID()` for the journal id, with a unique index on the business
reference.** This is the arrangement the schema-design guidance points toward
for hotspot avoidance, and a version 4 UUID is random, so it distributes
exactly as well as a hash. It would have worked, and it costs one more index
and one more failure mode: the row is written, the unique index rejects it, and
now there is a refusal to interpret rather than a key that simply already
exists. The unique index is kept anyway, as a declaration an auditor can read,
but the primary key is what does the work.

**A bit-reversed sequence.** The documentation describes bit-reversing
sequential values to avoid the hotspot that sequential keys cause. It solves
the distribution problem and not the identity problem: a sequence read inside
a retried body still hands out two numbers.

**A client-supplied journal id.** This pushes the derivation to the caller,
who may or may not do it the same way twice. The module keeps the derivation,
and the unique index on `BusinessRef` is what catches a caller who supplies an
id anyway.

## Consequences

The business reference becomes load-bearing. Two genuinely different events
that share a reference collide, and the second is refused — which is correct,
and which means the reference has to actually identify the event. This is the
same property Article 12 calls business uniqueness, and the same warning
applies: it never expires.

A journal cannot be posted twice "on purpose" with the same reference. Posting
the same economic event twice legitimately — a second fee of the same amount on
the same day — requires a reference that distinguishes them. That is a
requirement on the caller, and the module cannot soften it without giving up
the property that makes the retry safe.
