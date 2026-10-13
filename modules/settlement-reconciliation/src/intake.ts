/**
 * Intake: turning an arriving file into immutable evidence with an identity.
 *
 * The only decisions made here are about the file as an object. Nothing is
 * parsed, nothing is matched, and nothing is posted. A file that cannot be
 * parsed is still evidence and is still stored.
 */

import { createHash } from 'node:crypto';
import { crc32c } from './crc32c.ts';
import type { FileRecord, RawFile } from './types.ts';

export interface Mutations {
  /** Drop the content-digest test, so a re-sent file is re-ingested. */
  ignoreDuplicateDigest?: boolean;
  /** Ignore a declared correction, so the superseded file stays live. */
  ignoreSupersession?: boolean;
  /** Overwrite on a name collision instead of raising a conflict. */
  overwriteOnNameCollision?: boolean;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The evidence store. Append-only by construction: `records` is only ever
 * pushed to, and `bytes` is only ever written under a key that is absent.
 */
export class EvidenceStore {
  readonly records: FileRecord[] = [];
  private readonly bytes = new Map<string, string>();
  private readonly byDigest = new Map<string, string>();
  private readonly liveByName = new Map<string, string>();
  private readonly mutations: Mutations;

  constructor(mutations: Mutations = {}) {
    this.mutations = mutations;
  }

  /** Raw bytes for a stored file. Returns undefined for an unknown fileId. */
  read(fileId: string): string | undefined {
    return this.bytes.get(fileId);
  }

  get(fileId: string): FileRecord | undefined {
    return this.records.find((r) => r.fileId === fileId);
  }

  /** Every file whose content is live: accepted and not superseded. */
  live(): FileRecord[] {
    return this.records.filter(
      (r) => r.disposition === 'ACCEPTED' && r.supersededBy === null,
    );
  }

  /**
   * Admit one arrival.
   *
   * Four outcomes, in this order, because the order is the design:
   *   1. the same bytes again             -> DUPLICATE_IGNORED
   *   2. the same name, different bytes   -> CONTENT_CONFLICT (an exception)
   *   3. a declared correction            -> the named file is SUPERSEDED
   *   4. anything else                    -> ACCEPTED
   *
   * Putting (2) before (3) is what stops a provider silently replacing a file
   * it never said it was replacing.
   */
  admit(file: RawFile): FileRecord {
    const digest = sha256(file.bytes);
    const nameKey = `${file.source}/${file.declaredName}`;
    const fileId = `f-${digest.slice(0, 12)}`;

    const seen = this.byDigest.get(digest);
    if (seen !== undefined && !this.mutations.ignoreDuplicateDigest) {
      return this.push({
        fileId: `${fileId}-dup${this.records.length}`,
        source: file.source,
        declaredName: file.declaredName,
        digest,
        crc32c: crc32c(file.bytes),
        format: file.format,
        formatVersion: file.formatVersion,
        receivedAt: file.receivedAt,
        byteLength: file.bytes.length,
        disposition: 'DUPLICATE_IGNORED',
        supersedes: null,
        supersededBy: null,
        note: `byte-identical to ${seen}`,
      });
    }

    const liveSameName = this.liveByName.get(nameKey);
    const declaredCorrection = file.corrects !== undefined;
    if (
      liveSameName !== undefined &&
      !declaredCorrection &&
      !this.mutations.overwriteOnNameCollision
    ) {
      return this.push({
        fileId: `${fileId}-conflict${this.records.length}`,
        source: file.source,
        declaredName: file.declaredName,
        digest,
        crc32c: crc32c(file.bytes),
        format: file.format,
        formatVersion: file.formatVersion,
        receivedAt: file.receivedAt,
        byteLength: file.bytes.length,
        disposition: 'CONTENT_CONFLICT',
        supersedes: null,
        supersededBy: null,
        note: `name already held by ${liveSameName} with a different digest`,
      });
    }

    let supersedes: string | null = null;
    if (declaredCorrection && !this.mutations.ignoreSupersession) {
      const targetKey = `${file.source}/${file.corrects}`;
      const target = this.liveByName.get(targetKey);
      if (target !== undefined) {
        const prior = this.records.find((r) => r.fileId === target);
        if (prior) {
          prior.supersededBy = fileId;
          prior.disposition = 'SUPERSEDED';
        }
        this.liveByName.delete(targetKey);
        supersedes = target;
      }
    }

    this.bytes.set(fileId, file.bytes);
    this.byDigest.set(digest, fileId);
    this.liveByName.set(nameKey, fileId);
    return this.push({
      fileId,
      source: file.source,
      declaredName: file.declaredName,
      digest,
      crc32c: crc32c(file.bytes),
      format: file.format,
      formatVersion: file.formatVersion,
      receivedAt: file.receivedAt,
      byteLength: file.bytes.length,
      disposition: 'ACCEPTED',
      supersedes,
      supersededBy: null,
      note: supersedes === null ? 'first arrival' : `corrects ${supersedes}`,
    });
  }

  private push(record: FileRecord): FileRecord {
    this.records.push(record);
    return record;
  }

  /** A manifest an auditor can re-derive from the bytes alone. */
  manifest(): Array<Pick<FileRecord, 'fileId' | 'declaredName' | 'digest' | 'crc32c' | 'byteLength' | 'disposition'>> {
    return this.records
      .map((r) => ({
        fileId: r.fileId,
        declaredName: r.declaredName,
        digest: r.digest,
        crc32c: r.crc32c,
        byteLength: r.byteLength,
        disposition: r.disposition,
      }))
      .sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  }
}
