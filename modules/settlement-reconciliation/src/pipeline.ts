/**
 * One run of the reconciliation, end to end.
 *
 * intake -> parse -> normalise -> match -> explain -> cases -> posting decision
 *
 * Every stage is pure given its inputs, and every input is passed in,
 * including the clock. Running the same corpus twice produces byte-identical
 * output, which is what `make verify` checks.
 */

import { EvidenceStore, type Mutations as IntakeMutations } from './intake.ts';
import { ParseRefusal, parseFile } from './parsers.ts';
import { match, type MatchMutations } from './match.ts';
import { netOf } from './money.ts';
import { openCases } from './exceptions.ts';
import { decidePostings, type PostingMutations } from './posting.ts';
import { suggest, type Suggestion } from './suggest.ts';
import {
  aggregateDifference,
  conservation,
  providerNetFromRaw,
  providerPartition,
  rowConservation,
  type Conservation,
  type ProviderPartition,
  type RowBreach,
} from './oracle.ts';
import type {
  BankEntry,
  BatchSummary,
  Currency,
  ExceptionCase,
  Expectation,
  Explanation,
  FileRecord,
  NormalizedRecord,
  PostingInstruction,
  RawFile,
  RunConfig,
} from './types.ts';

export interface AllMutations {
  intake?: IntakeMutations;
  match?: MatchMutations;
  posting?: PostingMutations;
  /** Parse every file with the version 1 parser suite. */
  parserGeneration?: 1 | 2;
}

export interface RunInput {
  expectations: Expectation[];
  files: RawFile[];
  config: RunConfig;
  mutations?: AllMutations;
}

export interface RunOutput {
  store: EvidenceStore;
  fileRecords: FileRecord[];
  parseRefusals: Array<{ fileId: string; declaredName: string; message: string }>;
  records: NormalizedRecord[];
  summaries: BatchSummary[];
  bank: BankEntry[];
  explanations: Explanation[];
  cases: ExceptionCase[];
  suggestions: Suggestion[];
  instructions: PostingInstruction[];
  conservation: Conservation[];
  rowBreaches: RowBreach[];
  providerPartition: ProviderPartition[];
  aggregate: {
    expected: number;
    provider: number;
    bank: number;
    difference: number;
    differenceToProvider: number;
  };
  depositsByBatch: Map<string, string>;
  /** Reads one line of stored evidence. Used to verify a disposition. */
  readEvidence: (locator: string) => string | undefined;
}

export function run(input: RunInput): RunOutput {
  const mut = input.mutations ?? {};
  const generation = mut.parserGeneration ?? 2;
  const store = new EvidenceStore(mut.intake);

  for (const f of input.files) {
    if (f.receivedAt > input.config.cutoff) continue;
    store.admit(f);
  }

  const records: NormalizedRecord[] = [];
  const summaries: BatchSummary[] = [];
  const bank: BankEntry[] = [];
  const parseRefusals: RunOutput['parseRefusals'] = [];

  for (const fr of store.live()) {
    const bytes = store.read(fr.fileId);
    if (bytes === undefined) continue;
    try {
      const parsed = parseFile(fr, bytes, generation);
      records.push(...parsed.records);
      summaries.push(...parsed.summaries);
      bank.push(...parsed.bank);
    } catch (err) {
      if (err instanceof ParseRefusal) {
        parseRefusals.push({ fileId: fr.fileId, declaredName: fr.declaredName, message: err.message });
      } else {
        throw err;
      }
    }
  }

  // Which batches have live detail, and which business day each batch covers.
  // An expectation is "evidenced" when its provider has published detail for
  // the batch covering the day it was captured.
  const batchesWithDetail = new Set(records.map((r) => r.batchId));
  const batchForDay = new Map<string, BatchSummary>();
  for (const s of summaries) batchForDay.set(`${s.source}|${s.businessDate}`, s);
  const evidenceArrivedFor = (e: Expectation): boolean => {
    const day = Math.floor(e.capturedAt / 86_400_000) * 86_400_000;
    const s = batchForDay.get(`${e.source}|${day}`);
    return s !== undefined && batchesWithDetail.has(s.batchId);
  };

  const { explanations, consumed, depositsByBatch } = match({
    expectations: input.expectations,
    records,
    summaries,
    bank,
    evidenceArrivedFor,
    config: input.config,
    mutations: mut.match,
  });

  const cases = openCases(explanations, input.config.cutoff);

  const recordById = new Map(records.map((r) => [r.recordId, r]));
  const instructions = decidePostings({
    explanations,
    records: recordById,
    depositsByBatch,
    cases,
    mutations: mut.posting,
  });

  const unmatchedExpectations = input.expectations.filter((e) =>
    explanations.some(
      (x) => x.side === 'INTERNAL' && x.subjectId === e.expectationId && x.counterpartIds.length === 0 && x.outcome !== 'MATCHED',
    ),
  );
  const unmatchedRecords = records.filter((r) => !consumed.has(r.recordId));
  const suggestions = suggest({
    unmatchedExpectations,
    unmatchedRecords,
    amountWindowMinor: 50_000,
    dateWindowMs: 3 * 86_400_000,
  });

  const liveViews = store.live().map((fr) => ({
    fileId: fr.fileId,
    format: fr.format,
    bytes: store.read(fr.fileId) ?? '',
  }));
  const rawTotals = providerNetFromRaw(liveViews);
  const recordNet = new Map<string, { netMinor: number; currency: Currency }>(
    records.map((r) => [r.recordId, { netMinor: r.netMinor, currency: r.currency }]),
  );

  const internalCheck = {
    expected: input.expectations.map((e) => ({
      id: e.expectationId,
      netMinor: netOf(e.grossMinor, e.expectedFeeMinor),
      currency: e.currency,
    })),
    explanations,
    recordNet,
  };

  return {
    store,
    fileRecords: store.records,
    parseRefusals,
    records,
    summaries,
    bank,
    explanations,
    cases,
    suggestions,
    instructions,
    conservation: conservation(internalCheck),
    rowBreaches: rowConservation(internalCheck),
    providerPartition: providerPartition(rawTotals, explanations, recordNet),
    aggregate: aggregateDifference(
      input.expectations.map((e) => netOf(e.grossMinor, e.expectedFeeMinor)),
      rawTotals,
      bank.map((b) => b.amountMinor),
    ),
    depositsByBatch,
    readEvidence: (locator: string): string | undefined => {
      const [fileId, lineText] = locator.split('#');
      if (fileId === undefined || lineText === undefined) return undefined;
      const bytes = store.read(fileId);
      if (bytes === undefined) return undefined;
      const lines = bytes.split('\n').filter((l) => l.trim() !== '');
      return lines[Number(lineText) - 1];
    },
  };
}

export const DEFAULT_CONFIG: RunConfig = {
  tolerance: { feeToleranceMinor: 2 },
  // Late enough that every file in the corpus has arrived.
  cutoff: Date.UTC(2026, 2, 10),
  aggregateOnly: false,
};

/** A cutoff before the bank statement arrives. Nothing may post. */
export const NO_BANK_CUTOFF: RunConfig = {
  tolerance: { feeToleranceMinor: 2 },
  cutoff: Date.UTC(2026, 2, 6),
  aggregateOnly: false,
};

/** The cutoff at which the last settlement file has not yet arrived. */
export const EARLY_CUTOFF: RunConfig = {
  tolerance: { feeToleranceMinor: 2 },
  cutoff: Date.UTC(2026, 2, 7),
  aggregateOnly: false,
};
