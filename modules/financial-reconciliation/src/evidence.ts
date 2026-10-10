// The immutable raw evidence store.
//
// Models object storage written once per delivery at a deterministic name,
// with a create-if-absent precondition. Cloud Storage documents that a
// generation-match precondition with a value of 0 "only proceeds if no object
// with the specified name exists in the bucket", and that a live object of
// that name makes the request fail with 412. That is the whole mechanism: a
// redelivered message cannot overwrite what the first delivery stored, and a
// redelivery carrying a *different body* under the same id is detectable
// rather than silent.
//
// Everything downstream of this store is derived and therefore disposable.
// That is the property that makes the pipeline's lateness window a tuning
// parameter instead of a data-loss event.

import { canonical } from "./identity.ts";
import type { RawRecord, SourceId } from "./types.ts";

export type WriteOutcome =
  /** Stored. This delivery had not been seen. */
  | "STORED"
  /** Refused: same name, byte-identical body. An ordinary redelivery. */
  | "DUPLICATE_DELIVERY"
  /** Refused: same name, different body. Something is wrong upstream. */
  | "PRECONDITION_CONFLICT";

export interface StoredObject {
  readonly name: string;
  readonly record: RawRecord;
  /** Monotonic per name, as a storage generation would be. Always 1 here. */
  readonly generation: number;
  /** Every arrival under this name, including the refused ones. */
  deliveries: number;
}

export class RawEvidenceStore {
  private readonly objects = new Map<string, StoredObject>();
  private readonly order: string[] = [];

  /** `source/sourceEventId`: deterministic, so a replay addresses the same object. */
  static name(source: SourceId, sourceEventId: string): string {
    return `${source}/${sourceEventId}`;
  }

  /**
   * Write once.
   *
   * There is no update path and no delete path, deliberately. The playbook for
   * this article forbids removing raw evidence after normalisation, and the
   * cheapest way to honour that is to give the store no method that could.
   */
  put(record: RawRecord): WriteOutcome {
    const name = RawEvidenceStore.name(record.source, record.sourceEventId);
    const existing = this.objects.get(name);
    if (existing === undefined) {
      this.objects.set(name, { name, record, generation: 1, deliveries: 1 });
      this.order.push(name);
      return "STORED";
    }
    existing.deliveries += 1;
    if (canonical(existing.record.body) === canonical(record.body)) {
      return "DUPLICATE_DELIVERY";
    }
    return "PRECONDITION_CONFLICT";
  }

  get(name: string): StoredObject | undefined {
    return this.objects.get(name);
  }

  /** Everything stored, in the order it was first stored. */
  all(): readonly StoredObject[] {
    return this.order.map((n) => this.objects.get(n)!);
  }

  get size(): number {
    return this.objects.size;
  }

  /**
   * Deliveries that arrived after the object already existed.
   *
   * Reported separately from the statement-level duplicate count, because the
   * two numbers answer different questions and a system that reports only this
   * one believes it has no duplicate problem.
   */
  get refusedDeliveries(): number {
    let n = 0;
    for (const o of this.objects.values()) n += o.deliveries - 1;
    return n;
  }
}
