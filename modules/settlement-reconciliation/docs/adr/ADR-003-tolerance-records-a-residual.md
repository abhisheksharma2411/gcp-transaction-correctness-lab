# ADR-003 — Tolerance matches the row and records the difference

**Status:** accepted
**Date:** 2026-10-09

## Context

Every reconciliation has a tolerance, because without one a rounding
difference of one minor unit becomes an exception and the queue fills with
work nobody will do. The usual implementation treats a within-tolerance
difference as equality: the row matches, and the difference is gone.

The playbook forbids the claim that "matching tolerance is harmless". The
reason is arithmetic rather than rhetorical. A tolerance that absorbs
differences makes the sum of the matched rows differ from the sum of the
expectations, by an amount nobody recorded and nobody can name.

## Decision

A difference inside the tolerance produces `MATCHED_WITH_ADJUSTMENT`, and the
residual is carried on the explanation and posted to a named adjustment
account. The row matches. The money does not vanish.

The invariant this preserves, per row:

```text
expected net = settled net + residual
```

## Alternatives considered

**Absorb the difference.** One line of code less, and the per-currency
conservation check still passes — which is how this version survived the first
pass of the test suite. Two residuals of equal size and opposite sign cancel
inside a currency total. The control that was supposed to catch absorption
reddened nothing until the conservation check was moved from per-currency to
per-row. The alternative is rejected, and the reason it was nearly accepted is
recorded in the review.

**Raise an exception on any difference.** Correct and unusable: in this corpus
it would add two cases worth one minor unit each. A queue that cannot be
cleared is not a control.

**Absorb, and reconcile the absorbed total separately.** This is the same
design with a nightly sweep bolted on, and it loses the row. The adjustment
account would carry a number with no explanation of which rows produced it.

## Consequences

- The adjustment account is non-empty in a healthy period. Its balance is a
  signal: a tolerance set too wide shows up as an adjustment total that grows
  with volume.
- Two offsetting residuals of +1 and −1 are posted separately. They cancel in
  the account and both are visible on their rows.
- The tolerance is a single number in minor units applied to the fee only.
  `docs/MODEL.md` records that a real policy is per corridor and proportional.

## Conditions that would change this

If the adjustment account were not reviewed, recording the residual would be
indistinguishable from absorbing it, and the honest move would be to narrow
the tolerance instead.
