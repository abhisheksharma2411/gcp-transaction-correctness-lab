/**
 * A small transactional store that models the *observable* semantics of a
 * Spanner read-write transaction: serializable isolation, and a transaction
 * that loses a conflict is ABORTED and retried by the client library rather
 * than silently interleaved.
 *
 * It does not model Spanner's internal locking, TrueTime, replication, commit
 * latency, or mutation limits. It exists so the invariant tests are
 * deterministic and runnable with no cloud project. SpannerStore in
 * spanner-store.ts implements the same interface against the real service.
 */

export class AbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortedError";
  }
}

export class UniqueViolationError extends Error {
  readonly index: string;
  readonly key: string;
  constructor(index: string, key: string) {
    super(`unique index ${index} violated for key ${key}`);
    this.name = "UniqueViolationError";
    this.index = index;
    this.key = key;
  }
}

export interface UniqueIndexSpec {
  name: string;
  table: string;
  /** Builds the index key from a row, or null when the row is not indexed. */
  key: (row: Record<string, unknown>) => string | null;
}

interface Cell {
  value: unknown;
  version: number;
}

export interface Transaction {
  read<T>(table: string, key: string): T | null;
  scan<T>(table: string, filter?: (row: T) => boolean): T[];
  write(table: string, key: string, row: unknown): void;
  delete(table: string, key: string): void;
}

export interface StoreStats {
  commits: number;
  aborts: number;
  attempts: number;
}

export interface TransactionalStore {
  runTransaction<T>(fn: (tx: Transaction) => Promise<T> | T): Promise<T>;
  snapshot<T>(table: string): T[];
  readonly stats: StoreStats;
}

const MAX_ATTEMPTS = 20;

export class InMemoryTransactionalStore implements TransactionalStore {
  private cells = new Map<string, Cell>();
  private indexes: UniqueIndexSpec[];
  private clock = 0;
  readonly stats: StoreStats = { commits: 0, aborts: 0, attempts: 0 };

  constructor(indexes: UniqueIndexSpec[] = []) {
    this.indexes = indexes;
  }

  private cellKey(table: string, key: string): string {
    return `${table} ${key}`;
  }

  /**
   * Runs fn in a serializable transaction. Reads are recorded; at commit,
   * any read whose version moved aborts the transaction and the whole body is
   * re-executed. This mirrors what a Spanner client library does on ABORTED.
   */
  async runTransaction<T>(fn: (tx: Transaction) => Promise<T> | T): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.stats.attempts++;
      const readSet = new Map<string, number>();
      const writeSet = new Map<string, unknown>();
      const deleteSet = new Set<string>();
      const self = this;

      const tx: Transaction = {
        read<R>(table: string, key: string): R | null {
          const ck = self.cellKey(table, key);
          if (deleteSet.has(ck)) return null;
          if (writeSet.has(ck)) return structuredClone(writeSet.get(ck)) as R;
          const cell = self.cells.get(ck);
          // Absence is a real observation: record version 0 so that another
          // transaction inserting this key is detected as a conflict.
          readSet.set(ck, cell ? cell.version : 0);
          return cell ? (structuredClone(cell.value) as R) : null;
        },
        scan<R>(table: string, filter?: (row: R) => boolean): R[] {
          const seen = new Map<string, R>();
          for (const [ck, cell] of self.cells) {
            if (!ck.startsWith(`${table} `)) continue;
            if (deleteSet.has(ck)) continue;
            readSet.set(ck, cell.version);
            seen.set(ck, structuredClone(cell.value) as R);
          }
          for (const [ck, value] of writeSet) {
            if (!ck.startsWith(`${table} `)) continue;
            seen.set(ck, structuredClone(value) as R);
          }
          const out: R[] = [];
          for (const row of seen.values()) {
            if (!filter || filter(row)) out.push(row);
          }
          return out;
        },
        write(table: string, key: string, row: unknown): void {
          const ck = self.cellKey(table, key);
          deleteSet.delete(ck);
          writeSet.set(ck, structuredClone(row));
        },
        delete(table: string, key: string): void {
          const ck = self.cellKey(table, key);
          writeSet.delete(ck);
          deleteSet.add(ck);
        },
      };

      let result: T;
      try {
        result = await fn(tx);
      } catch (err) {
        if (err instanceof AbortedError) {
          this.stats.aborts++;
          continue;
        }
        throw err;
      }

      let conflict = false;
      for (const [ck, observed] of readSet) {
        const current = this.cells.get(ck);
        const currentVersion = current ? current.version : 0;
        if (currentVersion !== observed) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        this.stats.aborts++;
        continue;
      }

      this.enforceUniqueIndexes(writeSet, deleteSet);

      this.clock++;
      for (const ck of deleteSet) this.cells.delete(ck);
      for (const [ck, value] of writeSet) {
        this.cells.set(ck, { value, version: this.clock });
      }
      this.stats.commits++;
      return result;
    }
    throw new AbortedError(`transaction aborted after ${MAX_ATTEMPTS} attempts`);
  }

  private enforceUniqueIndexes(
    writeSet: Map<string, unknown>,
    deleteSet: Set<string>,
  ): void {
    for (const index of this.indexes) {
      const claimed = new Map<string, string>();
      for (const [ck, cell] of this.cells) {
        if (!ck.startsWith(`${index.table} `)) continue;
        if (deleteSet.has(ck) || writeSet.has(ck)) continue;
        const k = index.key(cell.value as Record<string, unknown>);
        if (k !== null) claimed.set(k, ck);
      }
      for (const [ck, value] of writeSet) {
        if (!ck.startsWith(`${index.table} `)) continue;
        const k = index.key(value as Record<string, unknown>);
        if (k === null) continue;
        const existing = claimed.get(k);
        if (existing !== undefined && existing !== ck) {
          throw new UniqueViolationError(index.name, k);
        }
        claimed.set(k, ck);
      }
    }
  }

  snapshot<T>(table: string): T[] {
    const out: T[] = [];
    for (const [ck, cell] of this.cells) {
      if (ck.startsWith(`${table} `)) out.push(structuredClone(cell.value) as T);
    }
    return out;
  }
}

export const TABLES = {
  OPERATIONS: "payment_operations",
  OUTBOX: "payment_outbox",
  CLAIMS: "effect_claims",
  LEDGER: "ledger_entries",
  INBOX: "consumer_inbox",
} as const;

/**
 * Uniqueness for the protected business reference. Two different operation
 * ids must not both produce an effect for the same order. Operations that
 * ended FAILED_FINAL release the claim, because no money moved.
 */
export const BUSINESS_REFERENCE_INDEX: UniqueIndexSpec = {
  name: "uq_operation_business_reference",
  table: TABLES.OPERATIONS,
  key: (row) => {
    if (row.state === "FAILED_FINAL") return null;
    return `${row.operationType} ${row.businessReference}`;
  },
};
