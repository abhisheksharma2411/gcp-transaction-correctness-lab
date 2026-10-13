# ADR-004 — The conservation oracle shares no code with the pipeline

**Status:** accepted
**Date:** 2026-10-09

## Context

Across this programme the most reliable defect has been a checker that shares
arithmetic with the thing it checks. A ledger whose invariant and whose balance
rebuild both call the same signing helper cannot detect a bug in that helper:
the error and the check agree, and the suite stays green.

This module has the same shape available to it. The matcher computes net as
gross less fee; the conservation check compares expected net against settled
net. Written the obvious way, both call `src/money.ts`.

## Decision

`src/oracle.ts` imports `./types.ts`, type-only, and nothing else.

- It re-reads the **raw bytes**, not the parsed records, and finds the net and
  currency columns **by name** rather than by position, so a parser that
  mis-indexes a column cannot produce the same error here.
- It converts decimals with `Math.round(parseFloat(x) * 100)` where the
  pipeline uses an anchored regex that refuses anything but two decimal places.
- `tests/controls.test.ts` asserts the import list by reading the file, so the
  isolation fails the build rather than rotting quietly.

## Alternatives considered

**Reuse `src/money.ts` in the oracle and keep the comment.** Half the lines and
no protection. The comment is exactly what previous modules in this programme
had.

**Write the oracle in another language and shell out.** Genuinely independent,
and it breaks the zero-dependency, one-command property the lab is built on.
Recorded as the stronger option for a system where the stakes justify it.

**Derive the oracle's expectations from a second fixture file.** This would
make the corpus itself checkable, which the current design cannot do: if the
generator writes a wrong number, the pipeline and the oracle read the same
wrong number and agree. Rejected for this module because a hand-maintained
expectation file drifts; recorded in `docs/MODEL.md` as a real gap.

## Consequences

- Two decimal readers exist, and a currency with three minor digits would have
  to be added to both. That is the cost, and it is the point.
- The deposit tie-out has **no** independent path: `providerNetFromRaw` reads
  the detail files and ignores the summary and the bank statement. The review
  records this as an open gap rather than a solved problem.
- Conservation is checked per row as well as per currency, because the
  per-currency check shares the aggregation weakness the article is about.

## Conditions that would change this

If the oracle ever needs a parser — to read a real camt.053 statement, for
instance — the isolation test must be rewritten to assert that the parser is a
different one, not that there is none.
