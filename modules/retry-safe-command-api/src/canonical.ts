import { createHash } from "node:crypto";
import type { PaymentCommand } from "./types.ts";

/**
 * Fields that define business intent. A retry that changes any of these is a
 * different request wearing the same name, and must be rejected rather than
 * silently answered with the first result.
 *
 * `metadata` is deliberately excluded: callers legitimately vary correlation
 * ids and trace headers between retries, and rejecting those would push
 * callers toward minting new operation ids, which is the failure we are
 * trying to prevent.
 */
const PROTECTED_FIELDS = [
  "operationType",
  "businessReference",
  "amountMinor",
  "currency",
] as const;

/**
 * Canonical JSON: sorted keys, no insignificant whitespace, explicit types.
 * Two semantically identical requests must produce byte-identical input.
 */
export function canonicalize(command: PaymentCommand): string {
  const parts: string[] = [];
  for (const field of [...PROTECTED_FIELDS].sort()) {
    const value = command[field];
    if (value === undefined || value === null) {
      throw new Error(`protected field missing from command: ${field}`);
    }
    parts.push(JSON.stringify(field) + ":" + JSON.stringify(normalize(field, value)));
  }
  return "{" + parts.join(",") + "}";
}

function normalize(field: string, value: string | number): string | number {
  if (field === "currency" && typeof value === "string") return value.toUpperCase();
  if (field === "amountMinor") {
    if (!Number.isInteger(value)) {
      throw new Error("amountMinor must be an integer number of minor units");
    }
    return value;
  }
  return value;
}

export function requestFingerprint(command: PaymentCommand): string {
  return createHash("sha256").update(canonicalize(command), "utf8").digest("hex");
}

/**
 * The key handed to the payment provider.
 *
 * It is derived from the operation identity, so every retry of the same
 * operation presents the same key to the provider. It is not the raw
 * operationId: the provider is a separate trust and namespace boundary, and
 * the caller's identifier should not leak into a third party verbatim.
 */
export function providerOperationKey(operationType: string, operationId: string): string {
  return createHash("sha256")
    .update(`gcp-retry-safe-command-api|v1|${operationType}|${operationId}`, "utf8")
    .digest("hex")
    .slice(0, 40);
}

/**
 * Identity of a business effect. Downstream consumers deduplicate on this,
 * so it must be derivable from durable state rather than generated at
 * publish time.
 */
export function effectId(operationType: string, operationId: string): string {
  return `eff_${createHash("sha256")
    .update(`${operationType}|${operationId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}
