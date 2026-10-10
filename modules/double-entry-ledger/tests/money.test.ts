// Exact money. Every case here is a thing a float gets wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { convert, formatAmount, money, parseAmount, signedMinor, sum } from "../src/money.ts";

test("M01 a decimal literal becomes minor units exactly", () => {
  assert.equal(parseAmount("USD", "12.34").minor, 1234n);
  assert.equal(parseAmount("USD", "-0.07").minor, -7n);
  assert.equal(parseAmount("JPY", "500").minor, 500n);
  assert.equal(parseAmount("KWD", "1.005").minor, 1005n);
});

test("M02 more decimal places than the currency has is refused, not rounded", () => {
  assert.throws(() => parseAmount("USD", "1.005"), /Refusing to round silently/);
  assert.throws(() => parseAmount("JPY", "1.5"), /Refusing to round silently/);
});

test("M03 0.1 + 0.2 is 0.3 in minor units", () => {
  // The case Spanner's own numeric-data page uses to explain why FLOAT64 is
  // wrong for money: in doubles, (0.1 + 0.2) converts back to
  // 0.30000000000000004.
  const total = sum([parseAmount("USD", "0.10"), parseAmount("USD", "0.20")]);
  assert.equal(total.minor, parseAmount("USD", "0.30").minor);
  assert.notEqual(0.1 + 0.2, 0.3);
});

test("M04 formatting round-trips", () => {
  for (const [currency, text] of [
    ["USD", "0.00"],
    ["USD", "-12.34"],
    ["JPY", "7"],
    ["KWD", "-0.001"],
  ] as const) {
    assert.equal(formatAmount(parseAmount(currency, text)), text);
  }
});

test("M05 adding two currencies is an error, not a number", () => {
  assert.throws(() => sum([money("USD", 1n), money("EUR", 1n)]), /cannot add EUR to USD/);
});

test("M06 conversion returns its remainder instead of discarding it", () => {
  // 11000 USD minor at 10000/11000 is exactly 10000 EUR minor.
  const exact = convert(money("USD", 11_000n), "EUR", 10_000n, 11_000n);
  assert.equal(exact.converted.minor, 10_000n);
  assert.equal(exact.remainder, 0n);

  // 11001 does not divide. The residue is handed back rather than vanishing,
  // because a minor unit that disappears during conversion is an imbalance
  // nobody wrote down.
  const inexact = convert(money("USD", 11_001n), "EUR", 10_000n, 11_000n);
  assert.equal(inexact.converted.minor, 10_000n);
  assert.notEqual(inexact.remainder, 0n);
});

test("M07 direction carries the sign, never the amount", () => {
  assert.equal(signedMinor("DEBIT", money("USD", 500n)), 500n);
  assert.equal(signedMinor("CREDIT", money("USD", 500n)), -500n);
});

test("M08 an unknown currency is refused at construction", () => {
  assert.throws(() => money("XYZ", 1n), /unknown currency XYZ/);
});
