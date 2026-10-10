// The reconciliation case corpus.
//
// This is the module's contribution and the reason it is written as data
// rather than as assertions. Each case below is a JSON document: a list of
// declarative steps and a set of expectations about accepted financial
// effects, case states, exception reasons and -- the part that matters most --
// which layer stopped each arrival. `scripts/export-cases.ts` writes the
// corpus out, and the build fails if the file drifts from this source.
//
// A suite written as assertions in one language tests one implementation. A
// suite written as data is a specification that another implementation can be
// held to, and the interpreter at the bottom of this file is about 150 lines.
//
// The corpus deliberately separates three things that reconciliation writing
// usually runs together:
//
//   delivery de-duplication   did this message arrive before?
//   statement de-duplication  has this fact been asserted before?
//   business finality         is this position still open to contradiction?
//
// Mechanisms exist in this module for all three, and the negative controls at
// the bottom show that only two of them change the money.

import { Pipeline } from "./pipeline.ts";
import type { StoppedBy, Weaknesses } from "./pipeline.ts";
import { DEFAULT_CONFIG } from "./reconcile.ts";
import type { ReconcileConfig } from "./reconcile.ts";
import type { ClaimKind, ExceptionReason, RawRecord, Resolution, SourceId } from "./types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** The clock the whole corpus runs on. No wall clock anywhere in src/. */
export const T0 = Date.UTC(2026, 0, 5);

// ---------------------------------------------------------------------------
// The step vocabulary
// ---------------------------------------------------------------------------

export type Step =
  /** A delivery that has not been seen before. `at` is event time from T0. */
  | {
    do: "deliver"; id: string; source: SourceId; ref: string; kind: ClaimKind;
    gross: number; fee?: number; at: number; currency?: string;
    corrects?: string; alsoKnownAs?: { source: SourceId; ref: string }[];
    coversRefs?: string[];
  }
  /** The identical delivery again: same id, same body. */
  | { do: "redeliver"; from: string }
  /** The same facts under a new delivery id. A publish-side duplicate. */
  | { do: "restate"; id: string; from: string }
  /** The same facts, serialised with the keys in the opposite order. */
  | { do: "reorderKeys"; id: string; from: string }
  /** The same delivery id carrying a different body. */
  | { do: "corrupt"; from: string; gross: number }
  /** A delivery that will not normalise. */
  | { do: "malformed"; id: string; source: SourceId }
  /** Move processing time forward. */
  | { do: "advance"; ms: number }
  /** Run the finality sweep. */
  | { do: "close" }
  /** Throw away every derived store and keep the raw evidence and the ledger. */
  | { do: "rebuild" }
  /** Re-ingest everything in the raw evidence store. */
  | { do: "replay" }
  /** An operator decision. */
  | {
    do: "resolve"; source: SourceId; ref: string; actor: string;
    action: Resolution["action"]; note: string;
  };

export interface Expectation {
  /** Accepted financial effects. The number that matters. */
  readonly entries: number;
  /** Defaults to true; a case that expects an unbalanced ledger says so. */
  readonly balanced?: boolean;
  /** Exception reasons raised anywhere, sorted. */
  readonly exceptions?: readonly ExceptionReason[];
  readonly cases?: number;
  /** `state/finality` per case, sorted. */
  readonly states?: readonly string[];
  readonly dropped?: number;
  /** Only the keys listed are compared. */
  readonly stoppedBy?: Readonly<Partial<Record<StoppedBy, number>>>;
  readonly resolutions?: number;
  readonly rawObjects?: number;
}

export interface ReconCaseSpec {
  readonly id: string;
  readonly title: string;
  /** Which required behaviour from the article package this case covers. */
  readonly covers: string;
  readonly allowedLatenessMs?: number;
  readonly config?: Partial<ReconcileConfig>;
  readonly steps: readonly Step[];
  readonly expect: Expectation;
}

const EUR = "EUR";

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export const CASES: readonly ReconCaseSpec[] = [
  {
    id: "R01",
    title: "one transaction, captured and then settled",
    covers: "canonical event schema; normalized ledger; balanced entries",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-1", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-1", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
    ],
    expect: { entries: 2, cases: 1, states: ["MATCHED/FINAL"], exceptions: [] },
  },
  {
    id: "R02",
    title: "the same delivery arrives three times",
    covers: "same event delivered multiple times; duplicate source events",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-2", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "redeliver", from: "e1" },
      { do: "redeliver", from: "e1" },
    ],
    // The raw store refuses both repeats before anything is normalised. That
    // saves work, and it is not what keeps the money right: R03 removes the
    // delivery id entirely and the effect count is still one.
    expect: { entries: 1, rawObjects: 1, stoppedBy: { "raw-store": 2, accepted: 1 } },
  },
  {
    id: "R03",
    title: "one fact, two delivery ids",
    covers: "publish-side duplicates that carry different message IDs",
    steps: [
      { do: "deliver", id: "e1", source: "processor", ref: "pi-3", kind: "CAPTURED", gross: 4_200, at: 0 },
      { do: "restate", id: "e2", from: "e1" },
    ],
    // Pub/Sub documents that publish-side retries produce "redeliveries with
    // different message IDs", and Stripe documents that two separate Event
    // objects are sometimes generated for one fact. Delivery-id de-duplication
    // sees two messages here. Content addressing sees one assertion.
    expect: { entries: 1, rawObjects: 2, stoppedBy: { "statement-dedup": 1, accepted: 1 } },
  },
  {
    id: "R04",
    title: "the same facts, serialised with the keys in a different order",
    covers: "canonical identity; two sources agreeing with different encodings",
    steps: [
      { do: "deliver", id: "e1", source: "processor", ref: "pi-4", kind: "CAPTURED", gross: 7_000, at: 0 },
      { do: "reorderKeys", id: "e2", from: "e1" },
    ],
    expect: { entries: 1, stoppedBy: { "statement-dedup": 1 } },
  },
  {
    id: "R05",
    title: "two sources, two references, one transaction",
    covers: "two sources report the same business transaction differently",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-5", kind: "CAPTURED", gross: 10_000, at: 0 },
      {
        do: "deliver", id: "e2", source: "processor", ref: "pi-5", kind: "SETTLED",
        gross: 10_000, fee: 275, at: DAY, alsoKnownAs: [{ source: "gateway", ref: "txn-5" }],
      },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
    ],
    expect: { entries: 2, cases: 1, states: ["MATCHED/FINAL"], exceptions: [] },
  },
  {
    id: "R06",
    title: "two sources disagree about the amount",
    covers: "contradictory evidence is not silently resolved",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-6", kind: "CAPTURED", gross: 10_000, at: 0 },
      {
        do: "deliver", id: "e2", source: "processor", ref: "pi-6", kind: "CAPTURED",
        gross: 10_500, at: MIN, alsoKnownAs: [{ source: "gateway", ref: "txn-6" }],
      },
    ],
    expect: { entries: 1, cases: 1, exceptions: ["CONTRADICTORY_SOURCES"] },
  },
  {
    id: "R07",
    title: "settlement arrives late, inside the pipeline's window",
    covers: "late settlement records",
    allowedLatenessMs: 2 * DAY,
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-7", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-7b", kind: "CAPTURED", gross: 2_000, at: 3 * DAY },
      { do: "deliver", id: "e3", source: "gateway", ref: "txn-7", kind: "SETTLED", gross: 10_000, fee: 275, at: 2 * DAY },
    ],
    expect: { entries: 3, dropped: 0 },
  },
  {
    id: "R08",
    title: "settlement arrives after the pipeline's window and is dropped",
    covers: "late data beyond allowed lateness; missing settlement",
    allowedLatenessMs: 2 * DAY,
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-8", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-8b", kind: "CAPTURED", gross: 2_000, at: 4 * DAY },
      { do: "deliver", id: "e3", source: "gateway", ref: "txn-8", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "advance", ms: 10 * DAY },
      { do: "close" },
    ],
    // The record is in the raw store. Nothing has been lost; something has
    // been *not processed*, which is the only version of this that is
    // survivable. See the lateness experiment in scripts/report.ts.
    expect: {
      entries: 2, dropped: 1,
      exceptions: ["MISSING_SETTLEMENT", "MISSING_SETTLEMENT"],
      stoppedBy: { "late-window": 1 },
    },
  },
  {
    id: "R09",
    title: "replay while the de-duplication record is still live",
    covers: "deterministic replay; replay after partial failure",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-9", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-9", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "replay" },
    ],
    expect: { entries: 2, stoppedBy: { "statement-dedup": 2 } },
  },
  {
    id: "R10",
    title: "every derived store is rebuilt from raw evidence",
    covers: "accepted financial effect count does not grow silently on replay",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-10", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-10", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "advance", ms: 30 * DAY },
      { do: "rebuild" },
      { do: "replay" },
    ],
    // The case that decides whether the design holds. The de-duplication
    // record, the correlation structure and the reconciliation cases are all
    // gone; only the raw objects and the ledger survive. What stops a second
    // set of entries is the entry id, derived from the transaction and the
    // purpose, and nothing else.
    expect: { entries: 2, stoppedBy: { "ledger-entry-dedup": 2 } },
  },
  {
    id: "R11",
    title: "a correction arrives before the position goes final",
    covers: "corrections; traceable adjustment",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-11", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-11", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      {
        do: "deliver", id: "e3", source: "gateway", ref: "txn-11", kind: "SETTLED",
        gross: 10_000, fee: 276, at: 2 * DAY, corrects: "e2",
      },
    ],
    expect: { entries: 3, exceptions: [] },
  },
  {
    id: "R12",
    title: "a correction arrives after the position went final",
    covers: "correction after an earlier accepted record; business finality",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-12", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-12", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
      {
        do: "deliver", id: "e3", source: "gateway", ref: "txn-12", kind: "SETTLED",
        gross: 10_000, fee: 276, at: 6 * DAY, corrects: "e2",
      },
    ],
    // The original entry is untouched. The delta is posted against suspense
    // and a person is told, because a published position that moves is a
    // business event rather than a data event.
    expect: { entries: 3, exceptions: ["CORRECTION_AFTER_FINALITY"] },
  },
  {
    id: "R13",
    title: "a correction whose key fields do not match the original",
    covers: "invalid correction refused rather than applied",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-13", kind: "CAPTURED", gross: 10_000, at: 0 },
      {
        do: "deliver", id: "e2", source: "gateway", ref: "txn-13", kind: "SETTLED",
        gross: 10_000, fee: 275, at: DAY, corrects: "e1",
      },
    ],
    expect: { entries: 1, exceptions: ["INVALID_CORRECTION"] },
  },
  {
    id: "R14",
    title: "the processor kept more than the contract explains",
    covers: "fee or net-settlement difference",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-14", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-14", kind: "SETTLED", gross: 10_000, fee: 900, at: DAY },
    ],
    // The cash is real, so it is posted. What is unexplained is the fee, and
    // an exception is the honest representation of that.
    expect: { entries: 2, exceptions: ["FEE_UNEXPLAINED"] },
  },
  {
    id: "R15",
    title: "one settlement record covering two transactions",
    covers: "grouping differences between a source and the business",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-15a", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-15b", kind: "CAPTURED", gross: 5_000, at: MIN },
      {
        do: "deliver", id: "e3", source: "processor", ref: "payout-15", kind: "SETTLED",
        gross: 15_000, fee: 400, at: DAY, coversRefs: ["txn-15a", "txn-15b"],
      },
    ],
    // The money lands in suspense, not in a receivable. Allocating it without
    // an allocation key would balance and would be a guess recorded as a fact.
    expect: { entries: 3, exceptions: ["UNALLOCATED_GROUPING"], balanced: true },
  },
  {
    id: "R16",
    title: "a reversal after a capture",
    covers: "reversals",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-16", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-16", kind: "REVERSED", gross: 10_000, at: 2 * HOUR },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
    ],
    expect: { entries: 2, states: ["MATCHED/FINAL"], exceptions: [] },
  },
  {
    id: "R17",
    title: "the settlement arrives before the capture",
    covers: "out-of-order arrival; no dependence on delivery order",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-17", kind: "SETTLED", gross: 10_000, fee: 275, at: DAY },
      { do: "deliver", id: "e2", source: "gateway", ref: "txn-17", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
    ],
    expect: { entries: 2, states: ["MATCHED/FINAL"], exceptions: [], dropped: 0 },
  },
  {
    id: "R18",
    title: "the same delivery id arrives carrying a different body",
    covers: "immutable raw input",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-18", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "corrupt", from: "e1", gross: 99_999 },
    ],
    expect: { entries: 1, rawObjects: 1, exceptions: ["RAW_IMMUTABLE_CONFLICT"] },
  },
  {
    id: "R19",
    title: "a manual resolution, twice, both versions kept",
    covers: "manual resolution is versioned and auditable; exception queue",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-19", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "advance", ms: 7 * DAY },
      { do: "close" },
      {
        do: "resolve", source: "gateway", ref: "txn-19", actor: "ops-analyst-2",
        action: "AWAIT_EVIDENCE", note: "processor confirms a settlement file is delayed",
      },
      { do: "advance", ms: 7 * DAY },
      {
        do: "resolve", source: "gateway", ref: "txn-19", actor: "ops-analyst-2",
        action: "WRITE_OFF", note: "no settlement after fourteen days; written off",
      },
    ],
    expect: {
      entries: 2, resolutions: 2, states: ["RESOLVED/FINAL"],
      exceptions: ["MISSING_SETTLEMENT"],
    },
  },
  {
    id: "R20",
    title: "a case does not go final merely because the window elapsed",
    covers: "finality requires coherent evidence, not just a deadline",
    steps: [
      { do: "deliver", id: "e1", source: "gateway", ref: "txn-20", kind: "CAPTURED", gross: 10_000, at: 0 },
      { do: "advance", ms: 30 * DAY },
      { do: "close" },
      { do: "close" },
    ],
    expect: {
      entries: 1, states: ["UNMATCHED/PROVISIONAL"], exceptions: ["MISSING_SETTLEMENT"],
    },
  },
  {
    id: "R21",
    title: "a record that does not normalise",
    covers: "malformed evidence reaches the exception queue, not the ledger",
    steps: [
      { do: "malformed", id: "e1", source: "processor" },
    ],
    expect: { entries: 0, rawObjects: 1, exceptions: ["MALFORMED_RECORD"] },
  },
];

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

export interface CaseResult {
  readonly id: string;
  readonly title: string;
  readonly covers: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly observed: {
    entries: number;
    balanced: boolean;
    cases: number;
    exceptions: string[];
    states: string[];
    dropped: number;
    deliveries: number;
    statements: number;
    computations: number;
    rawObjects: number;
    resolutions: number;
    stoppedBy: Record<string, number>;
    digest: string;
  };
}

function bodyOf(step: Extract<Step, { do: "deliver" }>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: step.kind,
    ref: step.ref,
    currency: step.currency ?? EUR,
    occurredAtMs: T0 + step.at,
    grossMinor: step.gross,
  };
  if (step.fee !== undefined) body["feeMinor"] = step.fee;
  if (step.alsoKnownAs !== undefined) body["alsoKnownAs"] = step.alsoKnownAs;
  if (step.coversRefs !== undefined) body["coversRefs"] = step.coversRefs;
  return body;
}

function reversedKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body).reverse()) out[k] = body[k];
  return out;
}

export function runCase(spec: ReconCaseSpec, weaknesses: Weaknesses = {}): CaseResult {
  const pipeline = new Pipeline({
    allowedLatenessMs: spec.allowedLatenessMs ?? 30 * DAY,
    reconcile: { ...DEFAULT_CONFIG, ...(spec.config ?? {}) },
    weaknesses,
  });

  const records = new Map<string, RawRecord>();
  let now = T0;

  const deliver = (record: RawRecord): void => {
    pipeline.ingest([record]);
  };

  for (const step of spec.steps) {
    switch (step.do) {
      case "deliver": {
        const body = bodyOf(step);
        if (step.corrects !== undefined) {
          const target = records.get(step.corrects);
          if (target === undefined) throw new Error(`${spec.id}: unknown label ${step.corrects}`);
          // A correction names the delivery it corrects, which is what a
          // source actually puts on the wire. The pipeline resolves it.
          body["corrects"] = target.sourceEventId;
        }
        const record: RawRecord = {
          sourceEventId: step.id, source: step.source, receivedAtMs: now, body,
        };
        records.set(step.id, record);
        deliver(record);
        break;
      }
      case "redeliver": {
        const target = records.get(step.from);
        if (target === undefined) throw new Error(`${spec.id}: unknown label ${step.from}`);
        deliver({ ...target, receivedAtMs: now });
        break;
      }
      case "restate": {
        const target = records.get(step.from);
        if (target === undefined) throw new Error(`${spec.id}: unknown label ${step.from}`);
        const record: RawRecord = {
          sourceEventId: step.id, source: target.source, receivedAtMs: now, body: target.body,
        };
        records.set(step.id, record);
        deliver(record);
        break;
      }
      case "reorderKeys": {
        const target = records.get(step.from);
        if (target === undefined) throw new Error(`${spec.id}: unknown label ${step.from}`);
        const record: RawRecord = {
          sourceEventId: step.id, source: target.source, receivedAtMs: now,
          body: reversedKeys(target.body as Record<string, unknown>),
        };
        records.set(step.id, record);
        deliver(record);
        break;
      }
      case "corrupt": {
        const target = records.get(step.from);
        if (target === undefined) throw new Error(`${spec.id}: unknown label ${step.from}`);
        deliver({
          ...target, receivedAtMs: now,
          body: { ...(target.body as Record<string, unknown>), grossMinor: step.gross },
        });
        break;
      }
      case "malformed": {
        const record: RawRecord = {
          sourceEventId: step.id, source: step.source, receivedAtMs: now,
          body: { kind: "CAPTURED", ref: "txn-bad", grossMinor: 100, occurredAtMs: T0 },
        };
        records.set(step.id, record);
        deliver(record);
        break;
      }
      case "advance":
        now += step.ms;
        break;
      case "close":
        pipeline.close(now);
        break;
      case "rebuild":
        pipeline.rebuildDerived();
        break;
      case "replay":
        pipeline.replay();
        break;
      case "resolve": {
        const transactionId = pipeline.correlator.transactionId(step.source, step.ref);
        pipeline.resolve({
          transactionId, actor: step.actor, action: step.action, note: step.note,
        }, now);
        break;
      }
    }
  }

  const cases = [...pipeline.reconciler.cases.values()];
  const exceptions = cases.flatMap((c) => c.exceptions.map((x) => x.reason)).sort();
  const states = cases.map((c) => `${c.state}/${c.finality}`).sort();
  const resolutions = cases.reduce((n, c) => n + c.resolutions.length, 0);

  const observed = {
    entries: pipeline.ledger.count,
    balanced: pipeline.ledger.isBalanced(),
    cases: cases.length,
    exceptions,
    states,
    dropped: pipeline.tally.droppedLate,
    deliveries: pipeline.tally.deliveries,
    statements: pipeline.tally.statements,
    computations: pipeline.tally.computations,
    rawObjects: pipeline.raw.size,
    resolutions,
    stoppedBy: { ...pipeline.stoppedBy },
    digest: pipeline.digest(),
  };

  const failures: string[] = [];
  const e = spec.expect;
  const eq = (name: string, got: unknown, want: unknown): void => {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a !== b) failures.push(`${name}: expected ${b}, got ${a}`);
  };

  eq("entries", observed.entries, e.entries);
  eq("balanced", observed.balanced, e.balanced ?? true);
  if (e.exceptions !== undefined) eq("exceptions", observed.exceptions, [...e.exceptions].sort());
  if (e.cases !== undefined) eq("cases", observed.cases, e.cases);
  if (e.states !== undefined) eq("states", observed.states, [...e.states].sort());
  if (e.dropped !== undefined) eq("dropped", observed.dropped, e.dropped);
  if (e.resolutions !== undefined) eq("resolutions", observed.resolutions, e.resolutions);
  if (e.rawObjects !== undefined) eq("rawObjects", observed.rawObjects, e.rawObjects);
  if (e.stoppedBy !== undefined) {
    for (const [k, v] of Object.entries(e.stoppedBy)) {
      eq(`stoppedBy.${k}`, observed.stoppedBy[k] ?? 0, v);
    }
  }

  return {
    id: spec.id, title: spec.title, covers: spec.covers,
    passed: failures.length === 0, failures, observed,
  };
}

export function runCorpus(weaknesses: Weaknesses = {}): readonly CaseResult[] {
  return CASES.map((c) => runCase(c, weaknesses));
}

/** The negative controls. Each must turn specific, named cases red. */
export const MUTATIONS: readonly (keyof Weaknesses)[] = [
  "noDeliveryDedup", "noRawImmutability", "noStatementDedup", "naiveIdentity",
  "noCorrelation", "noEntryDedup", "noFinalityGate",
];

/** A control blunt enough to break almost everything. Expected to be rejected. */
export const BLUNT_MUTATION: keyof Weaknesses = "postEverythingTwice";
