# ADR-003: A region that cannot confirm authority must refuse, not guess

- Status: Accepted
- Date: 2026-09-15
- Article: 03

## Context

When a region cannot reach write authority it has three options: refuse, queue,
or answer from local state. The third is the most attractive to a product owner
and the most dangerous.

## Decision

Refuse explicitly, in a named safe mode, and never complete a business decision
from regional state.

## Why this option

The lab measures the alternative. Under an identical partition, with an
identical and impeccably behaved database:

| Application policy | Told the customer yes without confirmation | Side effects with nothing behind them | Database double-commits |
|---|---:|---:|---:|
| Authority-only | 0 | 0 | 0 |
| Local state | 2 | 2 | 0 |

The final column is the point. The database was never wrong. The business was
wrong twice, in two regions, for one operation, and it was the application that
made it so.

Queuing is rejected as a third option because a queue of writes waiting for
authority is an unbounded backlog of promises, which is Article 2's subject and
its warning. A region without authority should shed, not accumulate.

## Consequences

Safe mode must be a first-class, named, observable state rather than an error
path. Operators need to distinguish "refusing because authority is unreachable"
from "failing", because the first is correct behaviour and paging on it trains
people to ignore it.

The product consequence is real and should not be glossed: safe mode refuses
work that would otherwise have been accepted. That is the price of not having
to reconcile two truths afterwards, and the GitHub incident is the reference
for what that reconciliation costs.

## Conditions that would change the decision

An operation with no external side effect and no ordering requirement could be
accepted locally and reconciled later. Such operations exist, and the article's
runbook asks the reader to enumerate them explicitly rather than assuming all
operations are one kind or the other.
