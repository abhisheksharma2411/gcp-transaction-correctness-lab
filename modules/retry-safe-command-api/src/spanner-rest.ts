/**
 * A very small Spanner REST client, written against the emulator.
 *
 * It exists for one reason: to check the schema's safety properties against
 * the real engine instead of against my own model of it. The conformance
 * suite runs on the in-memory store; this checks that the claims the article
 * makes about Spanner - commit-time uniqueness enforcement, generated columns
 * driving a NULL_FILTERED index, ABORTED on write conflict - are actually
 * true of Spanner and not just true of my simulation.
 *
 * It is not a production client. Use @google-cloud/spanner for that.
 */

export interface SpannerTarget {
  endpoint: string;
  project: string;
  instance: string;
  database: string;
}

export function targetFromEnv(): SpannerTarget {
  const hostPort = process.env.SPANNER_EMULATOR_REST ?? "localhost:9020";
  return {
    endpoint: `http://${hostPort}/v1`,
    project: process.env.SPANNER_PROJECT ?? "retry-safe-lab",
    instance: process.env.SPANNER_INSTANCE ?? "lab-instance",
    database: process.env.SPANNER_DATABASE ?? "payments",
  };
}

export class SpannerError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpannerError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The emulator returns errors in two shapes: the standard {"error": {...}}
 * envelope, and a bare {"code": <gRPC number>, "message": "..."}. Map both,
 * because the retry loop depends on recognising ABORTED and the difference is
 * invisible until a transaction conflicts.
 */
const GRPC_CODES: Record<number, string> = {
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  13: "INTERNAL",
  14: "UNAVAILABLE",
};

export function toSpannerError(httpStatus: number, body: string): SpannerError {
  let code = "UNKNOWN";
  let message = body;
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: string; message?: string; code?: number };
      code?: number;
      message?: string;
    };
    const numeric = parsed.error?.code ?? parsed.code;
    code =
      parsed.error?.status ??
      (typeof numeric === "number" ? (GRPC_CODES[numeric] ?? `CODE_${numeric}`) : "UNKNOWN");
    message = parsed.error?.message ?? parsed.message ?? body;
  } catch {
    /* keep the raw body */
  }
  return new SpannerError(httpStatus, code, message);
}

async function call<T>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw toSpannerError(res.status, text);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export interface Mutation {
  insert?: { table: string; columns: string[]; values: unknown[][] };
  update?: { table: string; columns: string[]; values: unknown[][] };
  insertOrUpdate?: { table: string; columns: string[]; values: unknown[][] };
  delete?: { table: string; keySet: { keys?: unknown[][]; all?: boolean } };
}

export class SpannerSession {
  private target: SpannerTarget;
  private sessionName: string | null = null;

  constructor(target: SpannerTarget) {
    this.target = target;
  }

  private get databasePath(): string {
    const t = this.target;
    return `projects/${t.project}/instances/${t.instance}/databases/${t.database}`;
  }

  async open(): Promise<void> {
    const res = await call<{ name: string }>(
      `${this.target.endpoint}/${this.databasePath}/sessions`,
    );
    this.sessionName = res.name;
  }

  async close(): Promise<void> {
    if (!this.sessionName) return;
    await call(`${this.target.endpoint}/${this.sessionName}`, undefined, "DELETE");
    this.sessionName = null;
  }

  private require(): string {
    if (!this.sessionName) throw new Error("session is not open");
    return this.sessionName;
  }

  async beginReadWrite(): Promise<string> {
    const res = await call<{ id: string }>(
      `${this.target.endpoint}/${this.require()}:beginTransaction`,
      { options: { readWrite: {} } },
    );
    return res.id;
  }

  async commit(transactionId: string, mutations: Mutation[]): Promise<{ commitTimestamp: string }> {
    return call(`${this.target.endpoint}/${this.require()}:commit`, {
      transactionId,
      mutations,
    });
  }

  async rollback(transactionId: string): Promise<void> {
    await call(`${this.target.endpoint}/${this.require()}:rollback`, { transactionId });
  }

  /** Single-use read-only query. */
  async query(sql: string): Promise<string[][]> {
    const res = await call<{ rows?: string[][] }>(
      `${this.target.endpoint}/${this.require()}:executeSql`,
      { sql },
    );
    return res.rows ?? [];
  }

  /** Query inside an open read-write transaction. */
  async queryInTransaction(transactionId: string, sql: string): Promise<string[][]> {
    const res = await call<{ rows?: string[][] }>(
      `${this.target.endpoint}/${this.require()}:executeSql`,
      { transaction: { id: transactionId }, sql },
    );
    return res.rows ?? [];
  }

  /** Commit a single mutation set in one transaction, with ABORTED retry. */
  async writeAtomically(mutations: Mutation[], maxAttempts = 10): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const txn = await this.beginReadWrite();
      try {
        await this.commit(txn, mutations);
        return;
      } catch (err) {
        if (err instanceof SpannerError && err.code === "ABORTED" && attempt < maxAttempts) {
          continue;
        }
        throw err;
      }
    }
  }
}

export async function emulatorReachable(target: SpannerTarget): Promise<boolean> {
  try {
    const res = await fetch(
      `${target.endpoint}/projects/${target.project}/instances/${target.instance}/databases`,
      { signal: AbortSignal.timeout(2000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}
