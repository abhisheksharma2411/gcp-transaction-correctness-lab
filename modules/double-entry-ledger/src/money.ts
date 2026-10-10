// Exact money. No floats anywhere, in any direction.
//
// Spanner's own documentation is the argument: "when you store the decimal
// value 0.2 using the FLOAT64 / FLOAT8 data type, the binary representation
// converts back to a decimal value of 0.20000000000000001". A ledger whose
// invariant is that debits equal credits cannot be built on a type that
// disagrees with itself about 0.1 + 0.2.
//
// Amounts are signed integer counts of minor units, held as bigint. The
// currency registry supplies the exponent, which is the only thing that turns
// a count of minor units back into a human-readable figure.

import type { CurrencyCode, Minor, Money } from "./types.ts";

/** Minor-unit exponents for the currencies this module models. Deliberately
 *  short: a real system takes these from a maintained table, and getting one
 *  wrong is a silent factor-of-100 error, not a crash. */
const EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
};

export function exponentOf(currency: CurrencyCode): number {
  const e = EXPONENTS[currency];
  if (e === undefined) throw new Error(`unknown currency ${currency}`);
  return e;
}

export function isKnownCurrency(currency: CurrencyCode): boolean {
  return Object.prototype.hasOwnProperty.call(EXPONENTS, currency);
}

/** Build an amount from minor units. The bigint is the point. */
export function money(currency: CurrencyCode, minor: Minor): Money {
  exponentOf(currency);
  return { currency, minor };
}

/**
 * Parse a decimal string into minor units, exactly.
 *
 * Rejects anything it cannot represent rather than rounding, because a
 * rounding rule chosen by a parser is a rounding rule nobody reviewed.
 */
export function parseAmount(currency: CurrencyCode, text: string): Money {
  const exp = exponentOf(currency);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (m === null) throw new Error(`not a decimal literal: ${text}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] ?? "0";
  const frac = m[3] ?? "";
  if (frac.length > exp) {
    throw new Error(
      `${text} has ${frac.length} decimal places; ${currency} has ${exp}. ` +
        "Refusing to round silently.",
    );
  }
  const padded = frac.padEnd(exp, "0");
  return { currency, minor: sign * BigInt(whole + padded) };
}

/** Render minor units as a decimal string. Pure string work, no division. */
export function formatAmount(amount: Money): string {
  const exp = exponentOf(amount.currency);
  const neg = amount.minor < 0n;
  const digits = (neg ? -amount.minor : amount.minor).toString().padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp);
  const frac = exp === 0 ? "" : `.${digits.slice(digits.length - exp)}`;
  return `${neg ? "-" : ""}${whole}${frac}`;
}

/** Signed sum of same-currency amounts. Throws on a currency mix, because
 *  adding two currencies is never a thing the caller meant. */
export function sum(amounts: readonly Money[]): Money {
  if (amounts.length === 0) throw new Error("sum of no amounts has no currency");
  const first = amounts[0];
  if (first === undefined) throw new Error("sum of no amounts has no currency");
  let total = 0n;
  for (const a of amounts) {
    if (a.currency !== first.currency) {
      throw new Error(`cannot add ${a.currency} to ${first.currency}`);
    }
    total += a.minor;
  }
  return { currency: first.currency, minor: total };
}

/**
 * Convert through an exact rational rate.
 *
 * The result is truncated toward zero and the remainder is returned, so the
 * caller has to decide where the residue goes instead of letting it vanish.
 * A conversion that quietly drops a minor unit is how a balanced journal
 * becomes an unbalanced one.
 */
export function convert(
  amount: Money,
  toCurrency: CurrencyCode,
  numerator: bigint,
  denominator: bigint,
): { readonly converted: Money; readonly remainder: bigint } {
  if (denominator === 0n) throw new Error("rate denominator is zero");
  exponentOf(toCurrency);
  const scaled = amount.minor * numerator;
  const converted = scaled / denominator;
  const remainder = scaled - converted * denominator;
  return { converted: { currency: toCurrency, minor: converted }, remainder };
}

/** The signed contribution of a posting to its account, in minor units.
 *  Debits are positive, credits negative. Which of those increases a balance
 *  depends on the account's normal balance, which is a reporting question —
 *  see `normalSign` in balances.ts. */
export function signedMinor(direction: "DEBIT" | "CREDIT", amount: Money): Minor {
  return direction === "DEBIT" ? amount.minor : -amount.minor;
}
