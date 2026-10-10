// The conformance matrix.
//
// This is the module's contribution, and the reason it is written as data
// rather than as tests: every case below is a JSON-serialisable document. An
// implementation in Java, Go, Kotlin or anything else satisfies the same
// contract by porting the ~120-line interpreter at the bottom of this file and
// running the identical matrix. `scripts/export-matrix.ts` writes it out.
//
// A conformance suite that is written as assertions in one language is a test
// suite for that language. A conformance suite that is written as data is a
// specification.

import { DeduplicatingQueue, TransactionalInbox, WebhookEndpoint } from "./boundaries.ts";
import { OperationProcessor } from "./processor.ts";
import { fingerprint } from "./fingerprint.ts";
import { IdempotencyStore } from "./store.ts";
import { EffectLedger } from "./effects.ts";
import type { ProviderMode } from "./effects.ts";
import type { CaughtBy } from "./processor.ts";
import type { Decision, Origin } from "./types.ts";

// ---------------------------------------------------------------------------
// The step vocabulary
// ---------------------------------------------------------------------------

export type Step =
  /** An arrival straight at the API. */
  | { do: "submit"; via: Origin; op: string; ref: string; payload: Record<string, unknown>; effect?: string }
  /** An arrival through a transactional inbox keyed on message id. */
  | { do: "inbox"; messageId: string; op: string; ref: string; payload: Record<string, unknown>; lostAck?: boolean }
  /** An arrival through a webhook keyed on the provider's event id. */
  | { do: "webhook"; eventId: string; op: string; ref: string; payload: Record<string, unknown> }
  /** An attempt to enqueue a deduplicating task. */
  | { do: "enqueue"; op: string; step: string }
  /** Move the clock. */
  | { do: "advance"; ms: number }
  /** Run the store's TTL, physically removing aged-out records. */
  | { do: "evict" }
  /** Resolve an operation the provider left unknown. */
  | { do: "resolve"; op: string };

export interface ConformanceCase {
  readonly id: string;
  readonly title: string;
  /** Which required behaviour from the article package this case covers. */
  readonly covers: string;
  readonly retentionMs: number;
  /** Task-name de-duplication window, where the case uses a queue. */
  readonly queueWindowMs?: number;
  /** Provider behaviour per operation id, consumed one entry per fresh call. */
  readonly providerModes?: Readonly<Record<string, readonly ProviderMode[]>>;
  readonly steps: readonly Step[];
  readonly expect: {
    /** Externally visible effects at the end. The number that matters. */
    readonly effects: number;
    /** Decision per `submit`/`inbox`/`webhook` step that reached the contract. */
    readonly decisions?: readonly Decision[];
    /** Which layer stopped each arrival; null means it did real work. */
    readonly caughtBy?: readonly (CaughtBy | null)[];
    /** Steps that must raise, by step index. */
    readonly rejectedSteps?: readonly number[];
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const PAY = { amount: 2500, currency: "EUR", recipient: "acct-77" };
const PAY_CHANGED = { amount: 9900, currency: "EUR", recipient: "acct-77" };

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export const MATRIX: readonly ConformanceCase[] = [
  {
    id: "C01",
    title: "same key, same payload, before the first copy finishes",
    covers: "same key and same payload before completion",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    // The first copy completes within the model's single step, so the second
    // sees a finished record. A system that blocks instead would report
    // IN_PROGRESS here; C02 covers the genuinely concurrent case.
    expect: { effects: 1, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C02",
    title: "a second copy arrives while the first is still running",
    covers: "concurrent duplicate operations; in-progress duplicates",
    retentionMs: DAY,
    providerModes: { "op-1": ["unknown"] },
    steps: [
      // The provider leaves this unknown, so the record stays open.
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 0, decisions: ["FIRST", "IN_PROGRESS"], caughtBy: [null, "contract"] },
  },
  {
    id: "C03",
    title: "same key, same payload, after the first copy finished",
    covers: "same key and same payload after completion",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "advance", ms: 5 * 60_000 },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C04",
    title: "same key, different payload",
    covers: "same key and different payload",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY_CHANGED },
    ],
    // Refused rather than silently replayed. Replaying the first response here
    // tells the caller their new request succeeded, which it did not.
    expect: { effects: 1, decisions: ["FIRST", "CONFLICT"], caughtBy: [null, "contract"] },
  },
  {
    id: "C05",
    title: "key order and whitespace differ, intent does not",
    covers: "canonical request hashing",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: { amount: 2500, currency: "EUR", recipient: "acct-77" } },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: { recipient: "acct-77", currency: "EUR", amount: 2500 } },
    ],
    expect: { effects: 1, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C06",
    title: "two different keys claim the same business reference",
    covers: "different keys for the same protected business reference",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "api", op: "op-2", ref: "ref-1", payload: PAY },
    ],
    // The contract cannot help: two ids are two operations. The business
    // constraint is the only thing that knows these describe one intent.
    expect: { effects: 1, decisions: ["FIRST", "FIRST"], caughtBy: [null, "business-uniqueness"] },
  },
  {
    id: "C07",
    title: "message redelivered after the effect, before the acknowledgement",
    covers: "message redelivery after successful side effect but before acknowledgment",
    retentionMs: DAY,
    steps: [
      { do: "inbox", messageId: "msg-1", op: "op-1", ref: "ref-1", payload: PAY, lostAck: true },
      // Pub/Sub resends; the inbox row was never committed, so this layer sees
      // a brand-new message. The operation contract is what saves it.
      { do: "inbox", messageId: "msg-1", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C08",
    title: "the same payload published twice gets two message ids",
    covers: "publish-side duplicates; duplicate delivery is not duplicate intent",
    retentionMs: DAY,
    steps: [
      { do: "inbox", messageId: "msg-1", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "inbox", messageId: "msg-2", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    // Exactly-once delivery does not deduplicate these: different ids.
    expect: { effects: 1, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C09",
    title: "a task name is refused inside its de-duplication window",
    covers: "task retry after worker timeout; deterministic task naming",
    retentionMs: DAY,
    queueWindowMs: DAY,
    steps: [
      { do: "enqueue", op: "op-1", step: "charge" },
      { do: "enqueue", op: "op-1", step: "charge" },
    ],
    expect: { effects: 0, rejectedSteps: [1] },
  },
  {
    id: "C10",
    title: "the same task name is accepted once the window has passed",
    covers: "key expiry; a de-duplication window is finite",
    retentionMs: DAY,
    queueWindowMs: DAY,
    steps: [
      { do: "enqueue", op: "op-1", step: "charge" },
      { do: "advance", ms: DAY + 1000 },
      { do: "enqueue", op: "op-1", step: "charge" },
    ],
    expect: { effects: 0 },
  },
  {
    id: "C11",
    title: "a workflow retries a step and carries the operation id",
    covers: "workflow retry after partial step completion",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "workflow", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "workflow", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "workflow", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1, decisions: ["FIRST", "REPLAY", "REPLAY"] },
  },
  {
    id: "C12",
    title: "a workflow retries a step and mints a fresh id each time",
    covers: "why a key generated independently on every retry is useless",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "workflow", op: "op-1-a", ref: "ref-1", payload: PAY },
      { do: "submit", via: "workflow", op: "op-1-b", ref: "ref-1", payload: PAY },
      { do: "submit", via: "workflow", op: "op-1-c", ref: "ref-1", payload: PAY },
    ],
    // Three operations as far as the contract can tell. Only the business
    // constraint stops this, and it stops it by refusing rather than by
    // replaying -- the caller gets an error, not a result.
    expect: {
      effects: 1,
      decisions: ["FIRST", "FIRST", "FIRST"],
      caughtBy: [null, "business-uniqueness", "business-uniqueness"],
    },
  },
  {
    id: "C13",
    title: "the provider times out and the outcome is unknown",
    covers: "provider timeout with unknown result; unknown outcomes",
    retentionMs: DAY,
    providerModes: { "op-1": ["unknown"] },
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    // No effect, and the operation is not closed. Guessing either way here is
    // the bug Article 1 is about.
    expect: { effects: 0, decisions: ["FIRST"], caughtBy: [null] },
  },
  {
    id: "C14",
    title: "an unknown outcome is resolved from the provider",
    covers: "unknown outcomes; stable keys make resolution possible",
    retentionMs: DAY,
    providerModes: { "op-1": ["unknown"] },
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "advance", ms: 30_000 },
      { do: "resolve", op: "op-1" },
    ],
    expect: { effects: 1 },
  },
  {
    id: "C15",
    title: "a replay after the record was evicted",
    covers: "replay after retention expiry; administrative replay",
    retentionMs: HOUR,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "advance", ms: 2 * HOUR },
      { do: "evict" },
      // The contract now says FIRST, because there is nothing left to say
      // otherwise. Everything below this line is what stops a second effect.
      { do: "submit", via: "replay", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1, decisions: ["FIRST", "FIRST"], caughtBy: [null, "effect-ledger"] },
  },
  {
    id: "C16",
    title: "a replay after eviction, under a different operation id",
    covers: "replay after retention expiry; business uniqueness outlives the key",
    retentionMs: HOUR,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "advance", ms: 2 * HOUR },
      { do: "evict" },
      { do: "submit", via: "replay", op: "op-9", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1, decisions: ["FIRST", "FIRST"], caughtBy: [null, "business-uniqueness"] },
  },
  {
    id: "C17",
    title: "a provider webhook fires twice for one operation",
    covers: "webhook duplication; downstream effect deduplication",
    retentionMs: DAY,
    steps: [
      { do: "webhook", eventId: "evt-1", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "webhook", eventId: "evt-1", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "webhook", eventId: "evt-2", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    // evt-1 twice is stopped at the endpoint; evt-2 is a different event
    // describing the same operation, and only the contract knows that.
    expect: { effects: 1 },
  },
  {
    id: "C18",
    title: "one operation causes two distinct effects",
    covers: "downstream effect deduplication; effect identity",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY, effect: "notify" },
      { do: "submit", via: "api", op: "op-2", ref: "ref-2", payload: PAY, effect: "provision" },
    ],
    // Two operations, two effect kinds, two effects. Deduplicating on the
    // operation alone would have suppressed the second.
    expect: { effects: 2 },
  },
  {
    id: "C19",
    title: "a final failure is recorded, not retried into existence",
    covers: "failed-final operations",
    retentionMs: DAY,
    providerModes: { "op-1": ["fail"] },
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 0, decisions: ["FIRST", "REPLAY"], caughtBy: [null, "contract"] },
  },
  {
    id: "C20",
    title: "every boundary at once, one operation",
    covers: "the whole matrix; arrivals versus effects",
    retentionMs: DAY,
    steps: [
      { do: "submit", via: "api", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "inbox", messageId: "msg-1", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "inbox", messageId: "msg-2", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "task", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "workflow", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "webhook", eventId: "evt-1", op: "op-1", ref: "ref-1", payload: PAY },
      { do: "submit", via: "replay", op: "op-1", ref: "ref-1", payload: PAY },
    ],
    expect: { effects: 1 },
  },
];

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly effects: number;
  readonly arrivals: number;
  readonly providerAttempts: number;
  readonly decisions: readonly Decision[];
  readonly caughtBy: readonly (CaughtBy | null)[];
  readonly rejectedSteps: readonly number[];
  readonly failures: readonly string[];
}

/**
 * A deliberately broken implementation, for negative controls.
 *
 * A conformance matrix written by the same hand as the implementation it
 * checks proves nothing until each case has been shown to fail when the layer
 * it targets is removed. These are the removals.
 */
export type Mutation =
  | "no-fingerprint-check"
  | "no-business-uniqueness"
  | "no-effect-ledger"
  | "naive-fingerprint";

export const MUTATIONS: readonly Mutation[] = [
  "no-fingerprint-check", "no-business-uniqueness", "no-effect-ledger", "naive-fingerprint",
];

/** Run one case against this module's implementation, or a broken variant. */
export function runCase(
  c: ConformanceCase,
  startMs: number = Date.UTC(2026, 0, 5),
  mutation?: Mutation,
): CaseResult {
  const modeCursor = new Map<string, number>();
  // A fingerprint that ignores key order: the mistake the canonical form fixes.
  const fp = mutation === "naive-fingerprint"
    ? (v: unknown) => JSON.stringify(v)
    : fingerprint;
  const processor = new OperationProcessor({
    retentionMs: c.retentionMs,
    skipFingerprintCheck: mutation === "no-fingerprint-check",
    providerMode: (operationId) => {
      const modes = c.providerModes?.[operationId];
      if (modes === undefined || modes.length === 0) return "ok";
      const i = modeCursor.get(operationId) ?? 0;
      modeCursor.set(operationId, i + 1);
      return modes[Math.min(i, modes.length - 1)]!;
    },
  },
    new IdempotencyStore(mutation !== "no-business-uniqueness"),
    new EffectLedger(mutation !== "no-effect-ledger"),
  );
  const inbox = new TransactionalInbox();
  const webhook = new WebhookEndpoint();
  const queue = new DeduplicatingQueue(c.queueWindowMs ?? c.retentionMs);

  let now = startMs;
  const decisions: Decision[] = [];
  const caughtBy: (CaughtBy | null)[] = [];
  const rejectedSteps: number[] = [];

  c.steps.forEach((step, index) => {
    switch (step.do) {
      case "advance":
        now += step.ms;
        break;
      case "evict":
        processor.store.evictExpired(now, c.retentionMs);
        break;
      case "resolve":
        processor.resolveUnknown(step.op, now);
        break;
      case "enqueue":
        try {
          queue.enqueue(step.op, step.step, now);
        } catch {
          rejectedSteps.push(index);
        }
        break;
      case "submit": {
        const r = processor.submit(
          {
            operationId: step.op,
            businessRef: step.ref,
            fingerprint: fp(step.payload),
            origin: step.via,
            attempt: 1,
          },
          now,
          step.effect ?? "notify",
        );
        decisions.push(r.decision);
        caughtBy.push(r.caughtBy);
        break;
      }
      case "inbox": {
        const ctx = {
          operationId: step.op,
          businessRef: step.ref,
          fingerprint: fp(step.payload),
          origin: "inbox" as const,
          attempt: 1,
        };
        const r = step.lostAck
          ? inbox.deliverWithLostAck(step.messageId, ctx, processor, now)
          : inbox.deliver(step.messageId, ctx, processor, now);
        if (r === "ALREADY_PROCESSED") break;
        decisions.push(r.decision);
        caughtBy.push(r.caughtBy);
        break;
      }
      case "webhook": {
        const r = webhook.receive(
          step.eventId,
          {
            operationId: step.op,
            businessRef: step.ref,
            fingerprint: fp(step.payload),
            origin: "provider",
            attempt: 1,
          },
          processor,
          now,
        );
        if (r === "DUPLICATE_EVENT") break;
        decisions.push(r.decision);
        caughtBy.push(r.caughtBy);
        break;
      }
    }
  });

  const failures: string[] = [];
  const eq = (a: readonly unknown[], b: readonly unknown[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  if (processor.effects.count !== c.expect.effects) {
    failures.push(`effects: expected ${c.expect.effects}, got ${processor.effects.count}`);
  }
  if (c.expect.decisions && !eq(decisions, c.expect.decisions)) {
    failures.push(`decisions: expected [${c.expect.decisions.join(", ")}], got [${decisions.join(", ")}]`);
  }
  if (c.expect.caughtBy && !eq(caughtBy, c.expect.caughtBy)) {
    failures.push(
      `caughtBy: expected [${c.expect.caughtBy.map(String).join(", ")}], got [${caughtBy.map(String).join(", ")}]`,
    );
  }
  if (c.expect.rejectedSteps && !eq(rejectedSteps, c.expect.rejectedSteps)) {
    failures.push(
      `rejected steps: expected [${c.expect.rejectedSteps.join(", ")}], got [${rejectedSteps.join(", ")}]`,
    );
  }

  return {
    id: c.id,
    title: c.title,
    passed: failures.length === 0,
    effects: processor.effects.count,
    arrivals: processor.tally.arrivals,
    providerAttempts: processor.tally.providerAttempts,
    decisions,
    caughtBy,
    rejectedSteps,
    failures,
  };
}

export function runMatrix(
  matrix: readonly ConformanceCase[] = MATRIX,
  mutation?: Mutation,
): readonly CaseResult[] {
  return matrix.map((c) => runCase(c, undefined, mutation));
}
