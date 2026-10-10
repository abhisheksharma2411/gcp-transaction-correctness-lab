// A small, deliberately unflattering model of the Spanner behaviour this
// ledger depends on. docs/MODEL.md lists every way it differs from the real
// thing; the short version is that this models semantics, never performance.
//
// Four documented behaviours are modelled because each one can change whether
// debits equal credits:
//
//   1. A read-write transaction body may run more than once.
//   2. Mutations are buffered and become visible only at commit.
//   3. Mutations are counted per column, against a per-commit limit.
//   4. Commit timestamps are not unique across transactions that touch
//      non-overlapping fields.
//
// And one access-control behaviour, because it is what makes a posting
// immutable in practice rather than by convention: privileges are granted per
// table, and a grant on a parent table does not reach its interleaved child.

export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export type DatabaseRole = {
  readonly name: string;
  /** Table name to the privileges granted on it. A table absent from this map
   *  has no privileges at all. */
  readonly grants: ReadonlyMap<string, ReadonlySet<Privilege>>;
};

/** How a principal reaches the database. Fine-grained access control applies
 *  only to principals that have no database-level IAM role; the docs say to
 *  revoke those so access is "managed by only one method", and this model
 *  shows what happens when you do not. */
export type Principal =
  | { readonly kind: "FGAC"; readonly id: string; readonly role: DatabaseRole }
  | { readonly kind: "DATABASE_IAM"; readonly id: string; readonly iamRole: string };

export class AccessDenied extends Error {
  readonly privilege: Privilege;
  readonly table: string;
  constructor(privilege: Privilege, table: string, principal: string) {
    super(`${principal} has no ${privilege} privilege on ${table}`);
    this.name = "AccessDenied";
    this.privilege = privilege;
    this.table = table;
  }
}

export class Aborted extends Error {
  constructor(reason: string) {
    super(`transaction aborted: ${reason}`);
    this.name = "Aborted";
  }
}

export class MutationLimitExceeded extends Error {
  readonly count: number;
  constructor(count: number, limit: number) {
    super(`commit needs ${count} mutations; the limit is ${limit}`);
    this.name = "MutationLimitExceeded";
    this.count = count;
  }
}

/** Mutations per commit, including indexes. The real figure from the Spanner
 *  quota page; see the source matrix. Insert and update operations count with
 *  the multiplicity of the number of columns they affect. */
export const MUTATION_LIMIT = 80_000;

export type Row = Readonly<Record<string, unknown>>;

type Buffered = {
  readonly table: string;
  readonly key: string;
  readonly op: "INSERT" | "UPDATE" | "DELETE";
  readonly row: Row | null;
  readonly columns: number;
};

export type CommitStats = {
  readonly attempts: number;
  readonly mutationCount: number;
  readonly commitTimestamp: string;
};

export type TransactionBody<T> = (txn: Transaction) => T;

export class Transaction {
  readonly attempt: number;
  private readonly db: SpannerModel;
  private readonly principal: Principal;
  private readonly buffer: Buffered[] = [];
  private readonly readKeys = new Set<string>();

  constructor(db: SpannerModel, principal: Principal, attempt: number) {
    this.db = db;
    this.principal = principal;
    this.attempt = attempt;
  }

  private require(privilege: Privilege, table: string): void {
    if (this.principal.kind === "DATABASE_IAM") {
      // Database-level IAM is not filtered by database roles. This branch
      // exists so a test can show it, not because it is a good idea.
      return;
    }
    const granted = this.principal.role.grants.get(table);
    if (granted === undefined || !granted.has(privilege)) {
      throw new AccessDenied(privilege, table, this.principal.id);
    }
  }

  read(table: string, key: string): Row | null {
    this.require("SELECT", table);
    this.readKeys.add(`${table}/${key}`);
    return this.db.rowAt(table, key);
  }

  /** Scan a table by key prefix. Models the common ledger read: every posting
   *  for one account, which is a contiguous range when the account id leads
   *  the primary key. */
  scan(table: string, prefix: string): readonly Row[] {
    this.require("SELECT", table);
    this.readKeys.add(`${table}/${prefix}*`);
    return this.db.rowsWithPrefix(table, prefix);
  }

  insert(table: string, key: string, row: Row): void {
    this.require("INSERT", table);
    this.buffer.push({ table, key, op: "INSERT", row, columns: Object.keys(row).length });
  }

  update(table: string, key: string, row: Row): void {
    this.require("UPDATE", table);
    this.buffer.push({ table, key, op: "UPDATE", row, columns: Object.keys(row).length });
  }

  delete(table: string, key: string): void {
    this.require("DELETE", table);
    this.buffer.push({ table, key, op: "DELETE", row: null, columns: 1 });
  }

  /** Mutations buffered so far, counted the way the quota page counts them:
   *  per column for inserts and updates, once for a delete. */
  mutationCount(): number {
    return this.buffer.reduce((n, b) => n + b.columns, 0);
  }

  internalBuffer(): readonly Buffered[] {
    return this.buffer;
  }

  internalReadKeys(): ReadonlySet<string> {
    return this.readKeys;
  }
}

export type RunOptions = {
  /** The commit tick this transaction will take if it succeeds. Supplied by
   *  the caller so that runs are reproducible; in Spanner it comes from
   *  TrueTime. */
  readonly tick: number;
  /** Force this many aborts before the commit is allowed through, so a test
   *  can exercise the documented behaviour that a body may run repeatedly. */
  readonly abortsBeforeCommit?: number;
  readonly maxAttempts?: number;
};

/** A change stream record as this model emits it. Deliberately the subset of
 *  the documented data change record that affects a ledger projection. */
export type RawChangeRecord = {
  readonly commitTimestamp: string;
  readonly serverTransactionId: string;
  readonly recordSequence: number;
  readonly numberOfRecordsInTransaction: number;
  readonly partition: string;
  readonly table: string;
  readonly modType: "INSERT" | "UPDATE" | "DELETE";
  readonly key: string;
  readonly row: Row | null;
};

export class SpannerModel {
  private readonly tables = new Map<string, Map<string, Row>>();
  /** Tables a change stream watches. Emitting from the storage layer rather
   *  than from the application is the point: a change stream sees every write
   *  to a watched table, including ones the application layer did not make. */
  private readonly watched = new Set<string>();
  private readonly stream: RawChangeRecord[] = [];
  private partitioner: (table: string, key: string) => string = () => "p1";
  /** Keys written at each tick, so the model can enforce that transactions
   *  sharing a commit timestamp wrote to non-overlapping fields. */
  private readonly writesByTick = new Map<number, Set<string>>();
  /** Every commit, in order. The audit view of the database. */
  readonly commits: { tick: number; keys: string[] }[] = [];

  /** CREATE CHANGE STREAM, more or less. */
  watchTable(name: string, partitioner?: (table: string, key: string) => string): void {
    this.watched.add(name);
    if (partitioner !== undefined) this.partitioner = partitioner;
  }

  changeStream(): readonly RawChangeRecord[] {
    return this.stream;
  }

  table(name: string): Map<string, Row> {
    let t = this.tables.get(name);
    if (t === undefined) {
      t = new Map<string, Row>();
      this.tables.set(name, t);
    }
    return t;
  }

  rowAt(table: string, key: string): Row | null {
    return this.table(table).get(key) ?? null;
  }

  rowsWithPrefix(table: string, prefix: string): readonly Row[] {
    const out: Row[] = [];
    for (const [key, row] of [...this.table(table).entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (key.startsWith(prefix)) out.push(row);
    }
    return out;
  }

  /** Format a tick as a commit timestamp. Microsecond granularity, as
   *  documented; the point of the format is that two transactions can share
   *  one. */
  static timestampOf(tick: number): string {
    const micros = String(tick).padStart(6, "0");
    return `2026-03-01T00:00:00.${micros}Z`;
  }

  /**
   * Run a body inside a read-write transaction, retrying on abort.
   *
   * The body is a function object, exactly as the client libraries require,
   * and this model executes it repeatedly. Anything the body does that is not
   * a buffered mutation happens once per attempt.
   */
  runReadWrite<T>(principal: Principal, options: RunOptions, body: TransactionBody<T>): {
    readonly value: T;
    readonly stats: CommitStats;
  } {
    const forcedAborts = options.abortsBeforeCommit ?? 0;
    const maxAttempts = options.maxAttempts ?? forcedAborts + 1;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      const txn = new Transaction(this, principal, attempt);
      let value: T;
      try {
        value = body(txn);
      } catch (error) {
        if (error instanceof Aborted) {
          lastError = error;
          continue;
        }
        throw error;
      }

      if (attempt <= forcedAborts) {
        // The buffer is discarded: nothing the body staged reaches the
        // database. Anything the body did outside the buffer already happened.
        lastError = new Aborted("injected");
        continue;
      }

      const count = txn.mutationCount();
      if (count > MUTATION_LIMIT) throw new MutationLimitExceeded(count, MUTATION_LIMIT);

      const keys = txn.internalBuffer().map((b) => `${b.table}/${b.key}`);
      const atTick = this.writesByTick.get(options.tick) ?? new Set<string>();
      for (const key of keys) {
        if (atTick.has(key)) {
          throw new Error(
            `two transactions wrote ${key} at tick ${options.tick}; ` +
              "transactions that write overlapping fields get distinct commit timestamps",
          );
        }
      }
      for (const key of keys) atTick.add(key);
      this.writesByTick.set(options.tick, atTick);

      const watchedMutations = txn
        .internalBuffer()
        .filter((m) => this.watched.has(m.table));
      let sequence = 0;
      for (const mutation of txn.internalBuffer()) {
        const table = this.table(mutation.table);
        if (mutation.op === "DELETE") table.delete(mutation.key);
        else if (mutation.row !== null) table.set(mutation.key, mutation.row);
        if (this.watched.has(mutation.table)) {
          sequence += 1;
          this.stream.push({
            commitTimestamp: SpannerModel.timestampOf(options.tick),
            serverTransactionId: `txn_${String(options.tick).padStart(6, "0")}`,
            recordSequence: sequence,
            numberOfRecordsInTransaction: watchedMutations.length,
            partition: this.partitioner(mutation.table, mutation.key),
            table: mutation.table,
            modType: mutation.op,
            key: mutation.key,
            row: mutation.row,
          });
        }
      }
      this.commits.push({ tick: options.tick, keys });

      return {
        value,
        stats: {
          attempts: attempt,
          mutationCount: count,
          commitTimestamp: SpannerModel.timestampOf(options.tick),
        },
      };
    }

    throw lastError instanceof Error ? lastError : new Aborted("retries exhausted");
  }
}

/** The append-only role from the fine-grained access control docs: SELECT and
 *  INSERT, no UPDATE and no DELETE. Note that Postings is granted separately
 *  from Journals, because a privilege on a parent table does not propagate to
 *  an interleaved child. */
export function appendOnlyRole(name = "ledger_writer"): DatabaseRole {
  const rw = new Set<Privilege>(["SELECT", "INSERT"]);
  return {
    name,
    grants: new Map<string, ReadonlySet<Privilege>>([
      ["Journals", rw],
      ["Postings", rw],
      ["AccountBalances", new Set<Privilege>(["SELECT", "INSERT", "UPDATE"])],
    ]),
  };
}

/** A role that can read the ledger and nothing else. */
export function readerRole(name = "ledger_reader"): DatabaseRole {
  const ro = new Set<Privilege>(["SELECT"]);
  return {
    name,
    grants: new Map<string, ReadonlySet<Privilege>>([
      ["Journals", ro],
      ["Postings", ro],
    ]),
  };
}

/** The footgun: a grant made on the parent table only. Reads of Journals
 *  succeed, reads of the interleaved Postings do not. */
export function parentOnlyRole(name = "journals_only"): DatabaseRole {
  return {
    name,
    grants: new Map<string, ReadonlySet<Privilege>>([
      ["Journals", new Set<Privilege>(["SELECT", "INSERT"])],
    ]),
  };
}
