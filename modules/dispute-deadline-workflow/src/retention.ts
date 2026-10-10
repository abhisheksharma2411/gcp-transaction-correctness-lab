// Retention and holds.
//
// Modelled on the two Cloud Storage mechanisms, because the difference between
// them is not obvious and gets chosen by accident.
//
// Cloud Storage documents both as metadata flags: "While an object has a hold
// placed on it, the object cannot be deleted or replaced. You can, however,
// edit the metadata of the object." The two types then diverge in one
// consequential way. For an object in a bucket with a retention policy,
// "Releasing an event-based hold resets the object's time in the bucket for
// the purposes of the retention period", whereas "Releasing a temporary hold
// does not affect the object's time in the bucket for the purposes of the
// retention period."
//
// Put plainly: release an event-based hold on a five-year-old piece of
// evidence and its retention clock restarts from zero. That is the intended
// behaviour for the use case Google names -- "holding loan documents for a
// certain period after the loan was paid" -- and it is the wrong behaviour for
// a litigation hold, which is why the same page says temporary holds "can be
// used for regulatory or legal purposes, such as holding trading documents for
// legal investigation."
//
// A dispute system wants both, for different reasons, on the same object.

import type { Instant } from './types.ts';

export type HoldKind = 'EVENT_BASED' | 'TEMPORARY';

export interface RetainedObject {
  itemId: string;
  /** When the object entered storage. */
  storedAt: Instant;
  /** The bucket-level retention period. */
  retentionMs: number;
  holds: HoldKind[];
  /**
   * The instant from which the retention period is measured. Equal to
   * `storedAt` until an event-based hold is released.
   */
  clockStartedAt: Instant;
}

export function create(itemId: string, storedAt: Instant, retentionMs: number, holds: HoldKind[]): RetainedObject {
  return { itemId, storedAt, retentionMs, holds: [...holds].sort(), clockStartedAt: storedAt };
}

export function retainUntil(object: RetainedObject): Instant {
  return object.clockStartedAt + object.retentionMs;
}

export type DeleteVerdict = 'DELETED' | 'BLOCKED_BY_HOLD' | 'BLOCKED_BY_RETENTION';

export function tryDelete(object: RetainedObject, now: Instant): DeleteVerdict {
  if (object.holds.length > 0) return 'BLOCKED_BY_HOLD';
  if (now < retainUntil(object)) return 'BLOCKED_BY_RETENTION';
  return 'DELETED';
}

export interface ReleaseResult {
  object: RetainedObject;
  clockReset: boolean;
  note: string;
}

export function releaseHold(object: RetainedObject, kind: HoldKind, at: Instant): ReleaseResult {
  if (!object.holds.includes(kind)) {
    return { object, clockReset: false, note: `no ${kind} hold to release` };
  }
  const holds = object.holds.filter((h) => h !== kind);
  if (kind === 'EVENT_BASED') {
    return {
      object: { ...object, holds, clockStartedAt: at },
      clockReset: true,
      note: 'event-based hold released; retention clock restarts from the release instant',
    };
  }
  return {
    object: { ...object, holds },
    clockReset: false,
    note: 'temporary hold released; retention clock unchanged',
  };
}

export function placeHold(object: RetainedObject, kind: HoldKind): RetainedObject {
  if (object.holds.includes(kind)) return object;
  return { ...object, holds: [...object.holds, kind].sort() };
}

/**
 * Metadata is editable while the bytes are not. Cloud Storage's retention
 * documentation states it directly: "An object's editable metadata is not
 * subject to a bucket's retention policy and can be modified even when the
 * object itself cannot be."
 *
 * That is why this module's evidence record carries a content digest and the
 * manifest commits to it. Immutable bytes with mutable labels are not an
 * immutable record: anything you can edit is anything you can get wrong later
 * and never notice.
 */
export const METADATA_IS_MUTABLE = true;
