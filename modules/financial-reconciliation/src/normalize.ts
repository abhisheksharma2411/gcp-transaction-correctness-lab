// Raw delivery to normalised assertion.
//
// Normalisation is allowed to reject, and it is not allowed to repair. A
// record that does not describe a coherent claim becomes an exception with the
// raw object still sitting in storage, because the alternative -- guessing a
// currency, defaulting a fee to zero -- produces a ledger that balances and is
// wrong.

import { evidenceId } from "./identity.ts";
import type { Observation, RawRecord, SourceId, SourceRef, ClaimKind } from "./types.ts";
import { CLAIM_KINDS, SOURCES } from "./types.ts";

export type NormalizeResult =
  | { ok: true; observation: Observation }
  | { ok: false; detail: string };

function int(body: Record<string, unknown>, key: string, fallback: number | null): number | null {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v;
}

function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function normalize(raw: RawRecord): NormalizeResult {
  const body = raw.body as Record<string, unknown>;

  if (!SOURCES.includes(raw.source)) return { ok: false, detail: `unknown source ${raw.source}` };

  const kindRaw = str(body, "kind");
  if (kindRaw === null || !CLAIM_KINDS.includes(kindRaw as ClaimKind)) {
    return { ok: false, detail: `unknown kind ${String(body["kind"])}` };
  }
  const kind = kindRaw as ClaimKind;

  const ref = str(body, "ref");
  if (ref === null) return { ok: false, detail: "missing ref" };

  const currency = str(body, "currency");
  if (currency === null) return { ok: false, detail: "missing currency" };

  const occurredAtMs = int(body, "occurredAtMs", null);
  if (occurredAtMs === null) return { ok: false, detail: "missing or non-integer occurredAtMs" };

  const grossMinor = int(body, "grossMinor", 0);
  const feeMinor = int(body, "feeMinor", 0);
  if (grossMinor === null || feeMinor === null) {
    return { ok: false, detail: "amounts must be integer minor units" };
  }
  if (grossMinor < 0 || feeMinor < 0) return { ok: false, detail: "amounts must not be negative" };

  // Net is derived, never trusted from the wire when gross and fee are both
  // present. A source that publishes all three and contradicts itself is a
  // malformed record, not an arithmetic puzzle to be solved downstream.
  const netOnWire = int(body, "netMinor", null);
  const netMinor = kind === "SETTLED" ? grossMinor - feeMinor : grossMinor;
  if (netOnWire !== null && netOnWire !== netMinor) {
    return {
      ok: false,
      detail: `net ${netOnWire} contradicts gross ${grossMinor} minus fee ${feeMinor}`,
    };
  }
  if (kind !== "SETTLED" && feeMinor !== 0) {
    return { ok: false, detail: `fee on a ${kind} record` };
  }

  const corrects = str(body, "corrects");

  const alsoRaw = body["alsoKnownAs"];
  const alsoKnownAs: SourceRef[] = [];
  if (alsoRaw !== undefined) {
    if (!Array.isArray(alsoRaw)) return { ok: false, detail: "alsoKnownAs must be a list" };
    for (const item of alsoRaw) {
      if (typeof item !== "object" || item === null) {
        return { ok: false, detail: "alsoKnownAs entries must be objects" };
      }
      const rec = item as Record<string, unknown>;
      const s = typeof rec["source"] === "string" ? (rec["source"] as SourceId) : null;
      const r = typeof rec["ref"] === "string" ? (rec["ref"] as string) : null;
      if (s === null || r === null || !SOURCES.includes(s)) {
        return { ok: false, detail: "malformed alsoKnownAs entry" };
      }
      alsoKnownAs.push({ source: s, ref: r });
    }
  }

  const coversRaw = body["coversRefs"];
  const coversRefs: string[] = [];
  if (coversRaw !== undefined) {
    if (!Array.isArray(coversRaw)) return { ok: false, detail: "coversRefs must be a list" };
    for (const item of coversRaw) {
      if (typeof item !== "string" || item.length === 0) {
        return { ok: false, detail: "malformed coversRefs entry" };
      }
      coversRefs.push(item);
    }
  }

  const claim = {
    source: raw.source,
    ref,
    kind,
    grossMinor,
    feeMinor,
    netMinor,
    currency,
    occurredAtMs,
    corrects,
    coversRefs,
  };

  return {
    ok: true,
    observation: {
      evidenceId: evidenceId(claim),
      sourceEventId: raw.sourceEventId,
      source: raw.source,
      ref,
      alsoKnownAs,
      kind,
      grossMinor,
      feeMinor,
      netMinor,
      currency,
      occurredAtMs,
      receivedAtMs: raw.receivedAtMs,
      corrects,
      coversRefs,
    },
  };
}
