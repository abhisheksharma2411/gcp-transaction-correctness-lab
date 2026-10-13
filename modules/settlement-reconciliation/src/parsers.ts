/**
 * Versioned parsers.
 *
 * A parser is identified by `format@version` and records that identifier on
 * every record it produces. Two rules hold throughout:
 *
 *   1. A parser verifies the header or shape it expects and REFUSES anything
 *      else. A settlement file whose schema has changed is a parse failure,
 *      not a column to guess at.
 *   2. A parser never repairs. If a provider's stated net disagrees with its
 *      own gross and fee, the record is produced with both numbers intact and
 *      the disagreement becomes a reconciliation exception downstream.
 */

import { decimalToMinor, isCurrency } from './money.ts';
import type {
  BankEntry,
  BatchSummary,
  Currency,
  FileRecord,
  Kind,
  NormalizedRecord,
} from './types.ts';

export class ParseRefusal extends Error {
  readonly fileId: string;
  constructor(fileId: string, message: string) {
    super(message);
    this.name = 'ParseRefusal';
    this.fileId = fileId;
  }
}

/** ISO `YYYY-MM-DD` to epoch milliseconds, UTC, without touching a clock. */
export function isoDateToMs(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not an ISO date: ${JSON.stringify(text)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function msToIsoDate(ms: number): string {
  const days = Math.floor(ms / 86_400_000) * 86_400_000;
  const d = new Date(days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function kindOf(raw: string, fileId: string, line: number): Kind {
  const value = raw.trim().toUpperCase();
  if (value === 'CAPTURE' || value === 'SALE') return 'CAPTURE';
  if (value === 'REFUND') return 'REFUND';
  if (value === 'CHARGEBACK') return 'CHARGEBACK';
  throw new ParseRefusal(fileId, `line ${line}: unknown transaction type ${JSON.stringify(raw)}`);
}

function currencyOf(raw: string, fileId: string, line: number): Currency {
  const value = raw.trim().toUpperCase();
  if (!isCurrency(value)) {
    throw new ParseRefusal(fileId, `line ${line}: unsupported currency ${JSON.stringify(raw)}`);
  }
  return value;
}

const ACQ_V1_HEADER = 'txn_id,merchant_ref,type,gross,fee,net,currency,event_date,batch_id';
const ACQ_V2_HEADER =
  'txn_id,merchant_ref,type,gross,fee,fee_breakdown,net,currency,transaction_date,batch_id';

/**
 * Acquirer transaction detail, CSV, decimal amounts.
 *
 * Version 1 accepts only its own header. Version 2 accepts both, which is the
 * property the parser-version test exercises: re-parsing a version 1 file with
 * version 2 must produce the same canonical records, byte for byte.
 */
function parseAcqCsv(
  file: FileRecord,
  bytes: string,
  parserVersion: 1 | 2,
): NormalizedRecord[] {
  const lines = bytes.split('\n').filter((l) => l.trim() !== '');
  const header = (lines[0] ?? '').trim();
  const isV1 = header === ACQ_V1_HEADER;
  const isV2 = header === ACQ_V2_HEADER;
  if (!isV1 && !isV2) {
    throw new ParseRefusal(file.fileId, `unrecognised header: ${JSON.stringify(header)}`);
  }
  if (isV2 && parserVersion === 1) {
    throw new ParseRefusal(
      file.fileId,
      'file uses the version 2 schema; parser acq-csv@1 refuses it',
    );
  }

  const out: NormalizedRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    const cols = lines[i]!.split(',');
    const expected = isV2 ? 10 : 9;
    if (cols.length !== expected) {
      throw new ParseRefusal(file.fileId, `line ${line}: expected ${expected} columns, found ${cols.length}`);
    }
    const currency = currencyOf(cols[isV2 ? 7 : 6]!, file.fileId, line);
    const gross = decimalToMinor(cols[3]!, currency);
    const fee = decimalToMinor(cols[4]!, currency);
    const net = decimalToMinor(cols[isV2 ? 6 : 5]!, currency);
    const dateCol = isV2 ? 8 : 7;
    out.push({
      recordId: `rec-${file.fileId}-${line}`,
      source: file.source,
      fileId: file.fileId,
      parserVersion: `acq-csv@${parserVersion}`,
      line,
      providerTxnId: cols[0]!.trim(),
      merchantRef: cols[1]!.trim(),
      kind: kindOf(cols[2]!, file.fileId, line),
      grossMinor: gross,
      feeMinor: fee,
      netMinor: net,
      currency,
      eventTime: isoDateToMs(cols[dateCol]!),
      batchId: cols[isV2 ? 9 : 8]!.trim(),
    });
  }
  return out;
}

interface PspLine {
  id: string;
  reference: string;
  kind: string;
  amount: { value: number; currency: string };
  fees: Array<{ type: string; value: number }>;
  net: number;
  settlement: { batch: string; eventDate: string };
}

/**
 * PSP settlement detail, JSON Lines, minor units, fees itemised.
 *
 * Two formats carrying the same facts in different shapes is the point: the
 * canonical record is what the matcher sees, and it is the parser's job to
 * reach it without inventing anything.
 */
function parsePspJsonl(file: FileRecord, bytes: string): NormalizedRecord[] {
  const lines = bytes.split('\n').filter((l) => l.trim() !== '');
  const out: NormalizedRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let row: PspLine;
    try {
      row = JSON.parse(lines[i]!) as PspLine;
    } catch {
      throw new ParseRefusal(file.fileId, `line ${line}: not JSON`);
    }
    if (row.amount === undefined || !Array.isArray(row.fees) || row.settlement === undefined) {
      throw new ParseRefusal(file.fileId, `line ${line}: missing a required field`);
    }
    const currency = currencyOf(row.amount.currency, file.fileId, line);
    let fee = 0;
    for (const f of row.fees) fee += f.value;
    out.push({
      recordId: `rec-${file.fileId}-${line}`,
      source: file.source,
      fileId: file.fileId,
      parserVersion: 'psp-jsonl@1',
      line,
      providerTxnId: row.id,
      merchantRef: row.reference,
      kind: kindOf(row.kind, file.fileId, line),
      grossMinor: row.amount.value,
      feeMinor: fee,
      netMinor: row.net,
      currency,
      eventTime: isoDateToMs(row.settlement.eventDate),
      batchId: row.settlement.batch,
    });
  }
  return out;
}

const SUMMARY_HEADER =
  'batch_id,business_date,gross,fee,net,currency,funding_date,payout_ref';

function parseBatchSummary(file: FileRecord, bytes: string): BatchSummary[] {
  const lines = bytes.split('\n').filter((l) => l.trim() !== '');
  if ((lines[0] ?? '').trim() !== SUMMARY_HEADER) {
    throw new ParseRefusal(file.fileId, 'unrecognised settlement-summary header');
  }
  const out: BatchSummary[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = i + 1;
    const cols = lines[i]!.split(',');
    if (cols.length !== 8) {
      throw new ParseRefusal(file.fileId, `line ${line}: expected 8 columns, found ${cols.length}`);
    }
    const currency = currencyOf(cols[5]!, file.fileId, line);
    out.push({
      batchId: cols[0]!.trim(),
      source: file.source,
      fileId: file.fileId,
      businessDate: isoDateToMs(cols[1]!),
      grossMinor: decimalToMinor(cols[2]!, currency),
      feeMinor: decimalToMinor(cols[3]!, currency),
      netMinor: decimalToMinor(cols[4]!, currency),
      currency,
      fundingDate: isoDateToMs(cols[6]!),
      payoutRef: cols[7]!.trim(),
    });
  }
  return out;
}

interface BankFile {
  accountId: string;
  entries: Array<{
    entryRef: string;
    amountMinor: number;
    currency: string;
    valueDate: string;
    remittance: string;
  }>;
}

function parseBankJson(file: FileRecord, bytes: string): BankEntry[] {
  let doc: BankFile;
  try {
    doc = JSON.parse(bytes) as BankFile;
  } catch {
    throw new ParseRefusal(file.fileId, 'bank statement is not JSON');
  }
  if (!Array.isArray(doc.entries)) {
    throw new ParseRefusal(file.fileId, 'bank statement has no entries array');
  }
  return doc.entries.map((e, i) => ({
    entryRef: e.entryRef,
    fileId: file.fileId,
    line: i + 1,
    amountMinor: e.amountMinor,
    currency: currencyOf(e.currency, file.fileId, i + 1),
    valueDate: isoDateToMs(e.valueDate),
    remittance: e.remittance,
  }));
}

export interface ParsedFile {
  records: NormalizedRecord[];
  summaries: BatchSummary[];
  bank: BankEntry[];
}

const EMPTY: ParsedFile = { records: [], summaries: [], bank: [] };

/**
 * Dispatch to a parser by declared format, at the requested parser generation.
 * `generation` is the version of the parser suite, not of the file.
 */
export function parseFile(
  file: FileRecord,
  bytes: string,
  generation: 1 | 2,
): ParsedFile {
  switch (file.format) {
    case 'acq-csv':
      return { ...EMPTY, records: parseAcqCsv(file, bytes, generation) };
    case 'psp-jsonl':
      return { ...EMPTY, records: parsePspJsonl(file, bytes) };
    case 'acq-summary-csv':
      return { ...EMPTY, summaries: parseBatchSummary(file, bytes) };
    case 'bank-json':
      return { ...EMPTY, bank: parseBankJson(file, bytes) };
    default:
      throw new ParseRefusal(file.fileId, `no parser for format ${JSON.stringify(file.format)}`);
  }
}
