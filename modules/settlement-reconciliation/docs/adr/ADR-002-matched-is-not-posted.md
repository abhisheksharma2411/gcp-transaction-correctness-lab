# ADR-002 — A match is not a posting, and a file is never ledger truth

**Status:** accepted
**Date:** 2026-10-09

## Context

The obvious design posts the settlement when the settlement file is parsed. The
file says the provider moved money; the ledger should record it. Every row that
matches an internal expectation becomes a journal, and the bank deposit is
checked later as a control.

Two documented behaviours argue against it, and both come from providers rather
than from theory. Stripe's payout reconciliation report groups a payout "by the
estimated arrival date shown on the Payouts page, not the date your bank posts
the deposit", and notes that "Report data follows a separate processing
schedule, so a payout might arrive before its reconciliation data is ready".
The file and the money are two events, in either order, and neither implies the
other. Stripe also documents that a payout can fail after the fact: "It can
take up to 5 additional business days for your bank to return the payout and
inform us that it failed."

Section 18.3 of the programme's playbook is explicit about the boundary this
module sits on: Article 19 "must not turn external files into ledger truth
without an explicit posting decision".

## Decision

`src/posting.ts` produces `PostingInstruction`s, never postings, and a
`POST_SETTLEMENT` instruction requires two independent facts:

1. a deterministic match rule fired, naming the rows it used; and
2. a bank entry confirmed the batch that the matched record belongs to.

Everything else is `DEFER` (the evidence has not arrived; the position is open,
not wrong), `HOLD` (an exception, until a named person dispositions it), or
`POST_ADJUSTMENT` (a residual, or a disposition that authorises one).

The gate is visible in the artefact: run the same corpus with the bank
statement withheld and 175 `POST_SETTLEMENT` instructions become 175 `DEFER`
instructions, with no change to any match.

## Alternatives considered

**Post on file receipt, reconcile the deposit separately.** The common design,
and cheaper: the ledger is current a day or two earlier, and finance gets its
numbers sooner. It fails on the failed payout. The file said the money moved,
the ledger says it moved, and five business days later the bank returns it —
so the correction is a reversal against a period that may already be closed.
The cost of the stricter rule is latency; the cost of the looser one is a
reversal with an audience.

**Post on deposit receipt only, ignoring the detail file.** Ties the ledger to
cash, which is appealing, and loses the composition: one deposit covers many
batches and many transactions, and a deposit alone cannot say which capture
settled. The corpus contains a deposit covering two batches from two different
providers for exactly this reason.

**Post on either, and de-duplicate.** This is the version that looks
pragmatic and is the hardest to audit, because the posting's basis depends on
which evidence happened to arrive first.

## Consequences

- The ledger lags the settlement file by the deposit's arrival. In this corpus
  that is one to two days.
- `DEFER` is a first-class outcome with its own count, so "nothing posted"
  and "nothing matched" cannot be confused.
- Every settlement instruction carries its basis as a string naming the rule
  and the deposit, which is what an auditor reads first.

## Conditions that would change this

A provider that guarantees funding — a same-day gross settlement, or a
contractual irrevocability — removes the failed-payout case, and with it the
argument for waiting. The gate would then be a policy choice about reporting
latency rather than a correctness one.
