# ADR-003: Replay reads the event log and refuses an unbounded scope

**Status:** accepted
**Date:** 2026-10-09

## Context

Pub/Sub can replay. Seeking to a timestamp "marks every message received by
Pub/Sub before the time as acknowledged, and all messages received after the
time as unacknowledged," and a snapshot can be used the same way. It is right
there, it needs no tooling, and it is the first thing anyone reaches for.

It also has limits that matter during a recovery, which is the only time anyone
runs a replay. The maximum lifetime of a snapshot is seven days. Subscription
message retention is 7 days by default and 31 at most, after which the service
"might discard the message independent of the acknowledgment state." A
subscription created today has no access to anything published yesterday. And
seeking in a subscription with a dead-letter topic sets the delivery attempts
to 0, so a message that was one attempt from being set aside gets its whole
budget back and goes round again.

## Decision

Replay reads the **event log** — the outbox table — and republishes from it.
`Broker.seek` exists in the model, and the tests use it to show what it does,
but the replay tool does not depend on it.

Replay scope is **bounded by construction**. `planReplay` refuses a scope with
neither an aggregate nor a time window, rather than defaulting to everything,
and `maxEvents` has no "unlimited" value. Test `R01` pins the refusal.

A **dry run is the plan function and nothing else**. `recordDryRun` calls
`planReplay` and stops. If the dry run and the execution were separate code
paths, the dry run would be a second implementation that could disagree with
the first, which is the one thing a dry run must not be.

## Consequences

- A consumer added long after the fact can be backfilled, because the log goes
  back further than the topic does. `R08` shows a fresh subscription receiving
  three events it was not present for.
- Replay is effect-neutral when the consumer guards hold, and the verifier is
  given the before-and-after effect sets so it can say so rather than assume
  it. `R05` asserts zero findings; `R07b` asserts `L09_REPLAY_DIVERGENCE` when
  the guards are removed.
- The event log has to be retained for as long as anyone might replay it, which
  is a storage cost the seek-based approach does not have. That is the trade.
- The tool publishes under the original event ids and sequences. Minting fresh
  ones would make every replayed event a new event to every consumer, which is
  a way of turning a recovery into an incident.

## What would change this decision

A pipeline whose consumers are stateless transformations with no protected
effects — a copy into BigQuery, say — can seek and be done. The bounded tool
earns its cost only where a replayed event can do something irreversible.
