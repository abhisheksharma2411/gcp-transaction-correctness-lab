// The balance projection, built by consuming the change feed.
//
// The projection is not the ledger. It is a cache of a sum that the postings
// already determine, and the only thing that makes it trustworthy is that it
// can be rebuilt and compared. Three properties of the real transport are
// modelled here because each one can corrupt a projection that assumes it is
// reading a tidy log:
//
//   1. A change stream is read per partition. Records for one transaction can
//      appear on several partitions, so a consumer can see one side of a
//      balanced journal before the other.
//   2. Ordering holds within a partition, not across partitions.
//   3. Records are returned once per query — but a consumer that crashes
//      before it checkpoints re-reads from its last checkpoint, so the effect
//      at the application layer is at-least-once regardless.

import { signedMinor } from "./money.ts";
import type { ChangeRecord, Minor } from "./types.ts";

export type ProjectionState = {
  readonly balances: ReadonlyMap<string, Minor>;
  readonly appliedPostingIds: ReadonlySet<string>;
  readonly checkpoints: ReadonlyMap<string, number>;
};

export class BalanceProjection {
  private readonly balances = new Map<string, Minor>();
  /** The inbox. A projection that does not record which postings it already
   *  applied cannot survive a redelivery, and redelivery is normal. */
  private readonly applied = new Set<string>();
  /** Per-partition position, which is what a consumer actually commits. */
  private readonly checkpoints = new Map<string, number>();
  private readonly dedupe: boolean;

  /** `dedupe: false` builds the version without an inbox, used as a negative
   *  control. It is never the default. */
  constructor(options: { dedupe?: boolean } = {}) {
    this.dedupe = options.dedupe ?? true;
  }

  balanceOf(accountId: string): Minor {
    return this.balances.get(accountId) ?? 0n;
  }

  snapshot(): ReadonlyMap<string, Minor> {
    return new Map(this.balances);
  }

  appliedCount(): number {
    return this.applied.size;
  }

  checkpointOf(partition: string): number {
    return this.checkpoints.get(partition) ?? 0;
  }

  /** Apply one record. Returns whether it changed the projection. */
  apply(record: ChangeRecord): boolean {
    if (this.dedupe && this.applied.has(record.posting.postingId)) return false;
    this.applied.add(record.posting.postingId);
    const prior = this.balances.get(record.posting.accountId) ?? 0n;
    this.balances.set(
      record.posting.accountId,
      prior + signedMinor(record.posting.direction, record.posting.amount),
    );
    return true;
  }

  /**
   * Consume one partition from a position, advancing the checkpoint only
   * after each record is applied.
   *
   * `crashAfter` stops without checkpointing, which is the failure that makes
   * redelivery normal rather than exotic.
   */
  consumePartition(
    feed: readonly ChangeRecord[],
    partition: string,
    options: { from?: number; crashAfter?: number } = {},
  ): { readonly applied: number; readonly skipped: number } {
    const records = partitionRecords(feed, partition);
    const from = options.from ?? this.checkpointOf(partition);
    let applied = 0;
    let skipped = 0;
    for (let i = from; i < records.length; i += 1) {
      const record = records[i];
      if (record === undefined) break;
      if (this.apply(record)) applied += 1;
      else skipped += 1;
      if (options.crashAfter !== undefined && applied + skipped >= options.crashAfter) {
        // The work happened; the checkpoint did not. Everything from `from`
        // will arrive again.
        return { applied, skipped };
      }
      this.checkpoints.set(partition, i + 1);
    }
    return { applied, skipped };
  }

  /** Consume every partition in the order the partitions happen to be named.
   *  Deliberately not the commit order, to make the cross-partition case the
   *  default rather than the exception. */
  consumeAll(feed: readonly ChangeRecord[]): void {
    for (const partition of partitionsOf(feed)) this.consumePartition(feed, partition);
  }
}

export function partitionsOf(feed: readonly ChangeRecord[]): readonly string[] {
  return [...new Set(feed.map((r) => r.partition))].sort();
}

export function partitionRecords(
  feed: readonly ChangeRecord[],
  partition: string,
): readonly ChangeRecord[] {
  // Within a partition, records arrive in commit timestamp order.
  return feed
    .filter((r) => r.partition === partition)
    .sort((a, b) =>
      a.commitTimestamp === b.commitTimestamp
        ? a.recordSequence - b.recordSequence
        : a.commitTimestamp < b.commitTimestamp
          ? -1
          : 1,
    );
}

/**
 * Whether the records seen so far contain every record of each transaction
 * they touch.
 *
 * A consumer that applies a partial transaction will observe a ledger in
 * which debits do not equal credits — not because the ledger is wrong, but
 * because it is reading an atomic write non-atomically. The fix is to buffer
 * by `serverTransactionId` until `numberOfRecordsInTransaction` records have
 * arrived, which is exactly what the field is for.
 */
export function completeTransactions(seen: readonly ChangeRecord[]): {
  readonly complete: readonly string[];
  readonly partial: readonly string[];
} {
  const counts = new Map<string, { seen: number; expected: number }>();
  for (const record of seen) {
    const entry = counts.get(record.serverTransactionId) ?? {
      seen: 0,
      expected: record.numberOfRecordsInTransaction,
    };
    entry.seen += 1;
    counts.set(record.serverTransactionId, entry);
  }
  const complete: string[] = [];
  const partial: string[] = [];
  for (const [id, entry] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.seen >= entry.expected) complete.push(id);
    else partial.push(id);
  }
  return { complete, partial };
}
