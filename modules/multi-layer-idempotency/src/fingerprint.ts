// Canonical request hashing.
//
// Two representations of one operation must produce the same fingerprint even
// when their JSON differs cosmetically, and different requests must not collide
// just because a client reordered its keys.

import { createHash } from "node:crypto";

export class FingerprintError extends Error {}

/**
 * Canonicalise a value to a stable string.
 *
 * Object keys are sorted; arrays keep their order, because order is meaning in
 * an array and noise in an object. Numbers go through `Number.prototype
 * .toString` so that 1 and 1.0 agree. `undefined` members are dropped so that
 * an explicitly-absent field and an omitted one agree -- but `null` is kept,
 * because a client sending null is saying something.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new FingerprintError(`non-finite number in request: ${String(value)}`);
    }
    return (value as number).toString();
  }
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "undefined") return "undefined";
  if (t === "bigint") return `${(value as bigint).toString()}n`;
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new FingerprintError(`cannot canonicalize ${t}`);
}

/** SHA-256 of the canonical form, hex. */
export function fingerprint(request: unknown): string {
  return createHash("sha256").update(canonicalize(request), "utf8").digest("hex");
}

/**
 * A de-duplication id for a queue that keys on name.
 *
 * Cloud Tasks documents that sequential ids, "for example using a timestamp,
 * causes an increase in latency and error rates in all task commands," and that
 * "using hashed strings for the task id or for the prefix of the task id is
 * recommended." So the id is a hash, and the readable part goes after it.
 */
export function taskId(operationId: string, step: string): string {
  const h = createHash("sha256").update(`${operationId}:${step}`, "utf8").digest("hex");
  return `${h.slice(0, 32)}-${step}`;
}

/**
 * The identity of one side effect.
 *
 * Derived from the operation and the kind of effect, so that the same
 * operation re-run produces the same effect id and the effect ledger can refuse
 * it. One operation causing three different effects produces three ids.
 */
export function effectId(operationId: string, kind: string): string {
  return createHash("sha256").update(`${operationId}\u0000${kind}`, "utf8")
    .digest("hex").slice(0, 32);
}
