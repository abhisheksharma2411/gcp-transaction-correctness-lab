// Three identities, and the correlation structure that joins them.
//
// Article 12 established the identity vocabulary for one *operation*: an
// operation id, a business reference and a request fingerprint. This module
// needs a different split, because the subject is not a command being retried
// but a stream of assertions about something that already happened:
//
//   sourceEventId  one delivery, named by whoever delivered it
//   evidenceId     one assertion of fact, named by its content
//   transactionId  one business transaction, named by correlation
//
// Collapsing any two of these produces a specific, named defect, and
// src/cases.ts contains the case that catches each one.

import { createHash } from "node:crypto";

export class IdentityError extends Error {}

/**
 * A stable string for a value.
 *
 * Object keys are sorted, because `{a:1,b:2}` and `{b:2,a:1}` are the same
 * assertion and a source is free to serialise either way. Arrays keep their
 * order, because order is meaning in a list. Numbers are required to be finite
 * integers here: this module counts minor units, and a float in an amount
 * field is a bug worth refusing rather than rounding.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new IdentityError(`non-finite number: ${String(n)}`);
    return Object.is(n, -0) ? "0" : n.toString();
  }
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "undefined") return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  throw new IdentityError(`cannot canonicalize ${t}`);
}

function sha(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The identity of an *assertion*, derived only from what is being asserted.
 *
 * Deliberately excluded: the delivery id, and the time this system received
 * it. Stripe's webhook documentation is explicit that "in some cases, two
 * separate Event objects are generated and sent", and that identifying those
 * duplicates needs the object and the event type rather than the event id.
 * Pub/Sub says the same thing from the other side: publish-side retries
 * produce "redeliveries with different message IDs". Both are the same defect,
 * and content addressing is the only thing that catches it.
 */
export function evidenceId(claim: {
  source: string;
  ref: string;
  kind: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  occurredAtMs: number;
  corrects: string | null;
  coversRefs: readonly string[];
}): string {
  return sha(canonical(claim)).slice(0, 40);
}

/** A deterministic id for one accepted financial effect. */
export function entryId(transactionId: string, evidence: string, purpose: string): string {
  return sha(`${transactionId}\u0000${evidence}\u0000${purpose}`).slice(0, 32);
}

/**
 * Correlation across sources that do not share a reference.
 *
 * A disjoint-set structure, not a lookup table, because correlation arrives
 * piecemeal: the gateway publishes `txn-88`, the processor publishes `pi_88`,
 * and only a third record carries both. Before that record arrives the two
 * references are genuinely two transactions as far as this system can tell,
 * and the model says so rather than guessing.
 */
export class Correlator {
  private readonly parent = new Map<string, string>();

  private key(source: string, ref: string): string {
    return `${source}:${ref}`;
  }

  /** Register a reference, creating its own group if it is new. */
  add(source: string, ref: string): string {
    const k = this.key(source, ref);
    if (!this.parent.has(k)) this.parent.set(k, k);
    return this.find(k);
  }

  private find(k: string): string {
    let cur = k;
    for (;;) {
      const p = this.parent.get(cur);
      if (p === undefined) {
        this.parent.set(cur, cur);
        return cur;
      }
      if (p === cur) return cur;
      const gp = this.parent.get(p);
      if (gp !== undefined) this.parent.set(cur, gp);
      cur = p;
    }
  }

  /** Assert that two references describe one transaction. */
  link(a: { source: string; ref: string }, b: { source: string; ref: string }): void {
    const ra = this.add(a.source, a.ref);
    const rb = this.add(b.source, b.ref);
    if (ra === rb) return;
    // Lexicographic union keeps the canonical id independent of arrival order,
    // which is what makes a replay produce the same transaction ids.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /** The canonical transaction id for a reference. */
  transactionId(source: string, ref: string): string {
    return this.find(this.key(source, ref));
  }

  /** Every reference currently in a group, sorted. */
  members(source: string, ref: string): string[] {
    const root = this.transactionId(source, ref);
    const out: string[] = [];
    for (const k of this.parent.keys()) if (this.find(k) === root) out.push(k);
    return out.sort();
  }
}

/**
 * A digest of a final state, for comparing one run against another.
 *
 * Replay is only a safety property if you can show that two runs produced the
 * same thing. A digest is the cheapest demonstration, provided it is taken
 * over sorted, canonicalised content and not over an iteration order.
 */
export function stateDigest(parts: readonly unknown[]): string {
  return sha(parts.map(canonical).sort().join("\u0001")).slice(0, 24);
}

/**
 * A deliberately wrong evidence id, used only by the negative controls.
 *
 * It hashes the delivery body as it arrived, so two sources that serialise the
 * same facts with their keys in a different order produce two identities, and
 * the pipeline posts the same money twice. This is what a reasonable-looking
 * implementation does when it hashes the payload instead of the claim.
 */
export function naiveEvidenceId(body: unknown): string {
  return sha(JSON.stringify(body)).slice(0, 40);
}
