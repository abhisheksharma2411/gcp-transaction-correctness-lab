// Evidence items and the immutable packet manifest.
//
// The packet is the unit of approval because it is the unit of submission.
// Stripe's API reference says of the Dispute object's evidence hash:
// "Updating any field in the hash submits all fields in the hash for review."
// Under a rule like that there is no such thing as adding one document to a
// submission already made. Changing anything re-submits everything, and the
// provider records it as another submission -- of which, the same reference
// notes, "Typically, you may only submit evidence once."
//
// So a reviewer who approves "the receipt and the delivery confirmation" has
// approved one specific set of bytes, and the system has to be able to prove
// afterwards which set that was. The manifest hash is that proof: a digest
// over the sorted item identities and their content digests, together with the
// rule version and deadline basis under which approval was given.

import { createHash } from 'node:crypto';
import type {
  DeadlineDecision,
  EvidenceItem,
  Instant,
  Packet,
  PacketEntry,
} from './types.ts';

export function digest(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update('\u0000', 'utf8');
  }
  return hash.digest('hex');
}

/** Stand-in for the digest of stored bytes; the bytes never enter this module. */
export function contentDigest(label: string): string {
  return digest(['content', label]).slice(0, 32);
}

export function entriesOf(items: EvidenceItem[]): PacketEntry[] {
  return items
    .map((item) => ({ itemId: item.itemId, contentHash: item.contentHash }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/**
 * The manifest hash.
 *
 * Sorted, so that the order items were collected in cannot change the digest.
 * Includes the rule version and the deadline basis, so that a packet approved
 * under one reading of the deadline is a different packet from the same
 * documents approved under another. It does not include the approver or the
 * approval time, because those identify the approval event rather than the
 * thing approved, and two people approving the same evidence must produce the
 * same manifest.
 */
export function manifestHash(
  caseId: string,
  entries: PacketEntry[],
  ruleVersion: string,
  deadlineBasis: string,
): string {
  const parts = ['manifest-v1', caseId, ruleVersion, deadlineBasis];
  for (const entry of entries) {
    parts.push(entry.itemId, entry.contentHash);
  }
  return digest(parts);
}

export interface ApprovalRequest {
  caseId: string;
  items: EvidenceItem[];
  decision: DeadlineDecision;
  approvedBy: string;
  approvedAt: Instant;
  approvalReason: string;
  /** Packet versions already approved for this case, oldest first. */
  existing: Packet[];
}

export type ApprovalResult =
  | { ok: true; packet: Packet; created: boolean }
  | { ok: false; error: string };

/**
 * Approve the current evidence set as a packet.
 *
 * Re-approving an unchanged set returns the existing packet rather than
 * minting a second version. Approving a changed set always mints a new
 * version: the earlier packet is never edited, because the earlier packet may
 * already have been sent.
 */
export function approve(request: ApprovalRequest): ApprovalResult {
  if (request.approvedBy.trim() === '') return { ok: false, error: 'approval requires an actor' };
  if (request.approvalReason.trim() === '') {
    return { ok: false, error: 'approval requires a reason' };
  }
  if (request.items.length === 0) {
    return { ok: false, error: 'approval requires at least one evidence item' };
  }
  const modelOnly = request.items.every((item) => item.origin === 'MODEL_SUGGESTED');
  if (modelOnly) {
    return { ok: false, error: 'a packet cannot consist only of model-suggested material' };
  }

  const entries = entriesOf(request.items);
  const hash = manifestHash(
    request.caseId,
    entries,
    request.decision.ruleVersion,
    request.decision.basis,
  );
  const last = request.existing[request.existing.length - 1];
  if (last && last.manifestHash === hash) {
    return { ok: true, packet: last, created: false };
  }

  const version = (last?.version ?? 0) + 1;
  return {
    ok: true,
    created: true,
    packet: {
      packetId: `${request.caseId}-p${version}`,
      caseId: request.caseId,
      version,
      entries,
      manifestHash: hash,
      ruleVersion: request.decision.ruleVersion,
      deadlineBasis: request.decision.basis,
      deadline: request.decision.deadline,
      approvedBy: request.approvedBy,
      approvedAt: request.approvedAt,
      approvalReason: request.approvalReason,
    },
  };
}

/**
 * Re-derive a packet's manifest hash from the items it names and the digests
 * recorded for them. This is the reproduction check: a packet whose stored
 * hash no longer matches its own entries has been tampered with or has been
 * written by code that disagrees with this function.
 */
export function reproduce(packet: Packet): { ok: boolean; recomputed: string } {
  const recomputed = manifestHash(
    packet.caseId,
    packet.entries,
    packet.ruleVersion,
    packet.deadlineBasis,
  );
  return { ok: recomputed === packet.manifestHash, recomputed };
}

/** Which items changed between two packet versions, for the audit trail. */
export function diffPackets(before: Packet, after: Packet): string[] {
  const lines: string[] = [];
  const beforeMap = new Map(before.entries.map((e) => [e.itemId, e.contentHash]));
  const afterMap = new Map(after.entries.map((e) => [e.itemId, e.contentHash]));
  for (const [itemId, hash] of afterMap) {
    const previous = beforeMap.get(itemId);
    if (previous === undefined) lines.push(`added ${itemId}`);
    else if (previous !== hash) lines.push(`replaced ${itemId}`);
  }
  for (const itemId of beforeMap.keys()) {
    if (!afterMap.has(itemId)) lines.push(`removed ${itemId}`);
  }
  if (before.ruleVersion !== after.ruleVersion) {
    lines.push(`rule version ${before.ruleVersion} -> ${after.ruleVersion}`);
  }
  return lines.sort();
}
