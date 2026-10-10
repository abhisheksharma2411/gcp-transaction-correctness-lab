# ADR-002: Effect identity is derived from the aggregate's position, not from the event id

**Status:** accepted
**Date:** 2026-10-09

## Context

A consumer needs to recognise an effect it has already applied. The obvious key
is the event id, since the inbox is keyed on it already:

```
effectId = hash(consumer, eventId, kind, subject)
```

It is one line and it is wrong in one case, which is the case where it is
needed.

The event id is a field a publisher writes. A relay that generates a fresh id
on each publish — which is what a UUID-per-message implementation does —
produces two event ids for one change. The inbox then misses, because the
inbox's whole key is the event id. If the effect identity is also derived from
the event id, the second guard misses for the same reason the first one did.
Two layers, one failure mode.

## Decision

Effect identity is derived from the aggregate's position in its own history:

```
effectId = hash(consumer, aggregateType:aggregateId#sequence, kind, subject)
```

The aggregate and the sequence are facts about the business change. They
survive republication, regeneration of the event id, and a replay from the
event log. Test `I05b` pins this: an envelope whose event id has been replaced
still yields the same effect identity.

`consumer` is part of the key for the opposite reason. Two consumers reacting
to one event are doing two different things and neither may suppress the other.
Test `I04` pins that.

## Consequences

- The layers now fail independently, which is the only reason to have more than
  one. Control `no-inbox` shows the sequence position catching a replay;
  control `no-message-dedup` shows the effect ledger catching it when both
  message-level guards are gone; control `no-guards` shows the duplicate that
  results when none of them is there.
- The identity depends on the aggregate carrying a meaningful sequence. A
  system emitting events with no per-entity ordering cannot use this scheme and
  has to find its identity in the payload.
- A consumer whose effect is genuinely the same across two sequences — "notify
  this customer about this order" — gets two effect identities and sends two
  notifications. That is correct for this model and may be wrong for a real
  one. Collapsing it is a business decision about what "the same notification"
  means, and this module does not make it.

## Rejected alternative

Keying on `(consumer, eventId, kind, subject)` and insisting that event ids be
derived. That works, and the module does derive them (`I01`). But it makes the
second guard depend on a property of the first, and a defence that fails the
same way as the thing it is defending is not a second defence.
