/**
 * Minor-unit arithmetic for the pipeline.
 *
 * This file is used by the parsers, the matcher and the posting decision.
 * It is deliberately NOT used by src/oracle.ts, which carries its own
 * decimal reader so that the conservation check and the thing it checks do
 * not share arithmetic. See ADR-004.
 */

import type { Currency } from './types.ts';

const SCALE: Record<Currency, number> = { USD: 100, EUR: 100 };

export function isCurrency(value: string): value is Currency {
  return value === 'USD' || value === 'EUR';
}

/**
 * Parse a decimal amount such as "-12.34" into signed minor units.
 * Throws on anything that is not exactly two decimal places, because a
 * settlement file that has changed its number format is a parse failure and
 * not a rounding opportunity.
 */
export function decimalToMinor(text: string, currency: Currency): number {
  const trimmed = text.trim();
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(trimmed);
  if (!m) throw new Error(`not a two-decimal amount: ${JSON.stringify(text)}`);
  const sign = m[1] === '-' ? -1 : 1;
  const units = Number(m[2]);
  const cents = Number(m[3]);
  return sign * (units * SCALE[currency] + cents);
}

export function minorToDecimal(minor: number, currency: Currency): string {
  const scale = SCALE[currency];
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / scale)}.${String(abs % scale).padStart(2, '0')}`;
}

/** Net as the merchant experiences it: gross less the fee charged against it. */
export function netOf(grossMinor: number, feeMinor: number): number {
  return grossMinor - feeMinor;
}

export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
