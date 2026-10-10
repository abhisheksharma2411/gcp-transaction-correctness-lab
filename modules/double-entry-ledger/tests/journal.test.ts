// Journal validation. The gate every journal passes through once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveJournalId, derivePostingId, netByCurrency, validate } from "../src/journal.ts";
import { money } from "../src/money.ts";
import { ACCOUNTS, BRIDGE_ACCOUNTS, CHART, LEDGER_ID } from "../src/scenario.ts";
import type { Account, JournalCommand, LineCommand } from "../src/types.ts";

const accounts = new Map<string, Account>(CHART.map((a) => [a.accountId, a]));
const bridge = new Set(BRIDGE_ACCOUNTS);

function command(lines: readonly LineCommand[], over: Partial<JournalCommand> = {}): JournalCommand {
  return {
    ledgerId: LEDGER_ID,
    businessRef: "ref-1",
    effectiveAt: "2026-02-10",
    description: "test",
    lines,
    ...over,
  };
}

function check(cmd: JournalCommand, over: Partial<Parameters<typeof validate>[0]> = {}) {
  return validate({
    command: cmd,
    accounts,
    usedBusinessRefs: new Set<string>(),
    closedThrough: null,
    bridgeAccountIds: bridge,
    ...over,
  });
}

const balanced: readonly LineCommand[] = [
  { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("USD", 500n), memo: "d" },
  { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: money("USD", 500n), memo: "c" },
];

test("J01 debits equal credits, so the journal is accepted", () => {
  const result = check(command(balanced));
  assert.equal(result.ok, true);
});

test("J02 one minor unit out is one minor unit too many", () => {
  const result = check(
    command([
      { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("USD", 500n), memo: "d" },
      { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: money("USD", 499n), memo: "c" },
    ]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.rejection.code, "UNBALANCED");
  assert.match(result.rejection.detail, /is 1 minor units/);
});

test("J03 a single posting cannot balance against anything", () => {
  const first = balanced[0];
  assert.ok(first !== undefined);
  const result = check(command([first]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "UNBALANCED");
});

test("J04 an empty journal records nothing and is refused", () => {
  const result = check(command([]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "EMPTY_JOURNAL");
});

test("J05 a business reference is used once", () => {
  const result = check(command(balanced), { usedBusinessRefs: new Set(["ref-1"]) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "DUPLICATE_BUSINESS_REF");
});

test("J06 a cross-currency journal without a bridge is refused", () => {
  const result = check(
    command([
      { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: money("USD", 1_100n), memo: "d" },
      { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: money("EUR", 1_000n), memo: "c" },
    ]),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "CROSS_CURRENCY_WITHOUT_BRIDGE");
});

test("J07 a cross-currency journal through the bridge, with a recorded rate, is accepted", () => {
  const result = check(
    command(
      [
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: money("USD", 1_100n), memo: "d" },
        { accountId: ACCOUNTS.bridgeUsd, direction: "CREDIT", amount: money("USD", 1_100n), memo: "out" },
        { accountId: ACCOUNTS.bridgeEur, direction: "DEBIT", amount: money("EUR", 1_000n), memo: "in" },
        { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: money("EUR", 1_000n), memo: "c" },
      ],
      {
        fxNote: {
          fromCurrency: "USD",
          toCurrency: "EUR",
          rateNumerator: 1_000n,
          rateDenominator: 1_100n,
          rateSource: "test",
        },
      },
    ),
  );
  assert.equal(result.ok, true);
});

test("J08 a bridge posting without a recorded rate is still refused", () => {
  const result = check(
    command([
      { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: money("USD", 1_100n), memo: "d" },
      { accountId: ACCOUNTS.bridgeUsd, direction: "CREDIT", amount: money("USD", 1_100n), memo: "out" },
      { accountId: ACCOUNTS.bridgeEur, direction: "DEBIT", amount: money("EUR", 1_000n), memo: "in" },
      { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: money("EUR", 1_000n), memo: "c" },
    ]),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "CROSS_CURRENCY_WITHOUT_BRIDGE");
});

test("J09 each currency must balance on its own, not in aggregate", () => {
  // Both sides of the bridge, but the euro leg does not tie. A check that
  // summed everything into one number would miss this.
  const result = check(
    command(
      [
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: money("USD", 1_100n), memo: "d" },
        { accountId: ACCOUNTS.bridgeUsd, direction: "CREDIT", amount: money("USD", 1_100n), memo: "out" },
        { accountId: ACCOUNTS.bridgeEur, direction: "DEBIT", amount: money("EUR", 1_000n), memo: "in" },
        { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: money("EUR", 999n), memo: "c" },
      ],
      {
        fxNote: {
          fromCurrency: "USD",
          toCurrency: "EUR",
          rateNumerator: 1_000n,
          rateDenominator: 1_100n,
          rateSource: "test",
        },
      },
    ),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.rejection.code, "UNBALANCED");
    assert.match(result.rejection.detail, /^EUR/);
  }
});

test("J10 a posting's currency must match its account's", () => {
  const result = check(
    command([
      { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("EUR", 500n), memo: "d" },
      { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: money("EUR", 500n), memo: "c" },
    ]),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "CURRENCY_MISMATCH");
});

test("J11 a negative amount is refused; the direction carries the sign", () => {
  const result = check(
    command([
      { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: money("USD", -500n), memo: "d" },
      { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: money("USD", 500n), memo: "c" },
    ]),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "ZERO_AMOUNT");
});

test("J12 an account from another ledger is refused", () => {
  const foreign: Account = {
    accountId: "acct_elsewhere",
    ledgerId: "ldg_other",
    kind: "ASSET",
    currency: "USD",
    path: "assets/elsewhere",
    openedEffectiveAt: "2026-01-01",
    closedEffectiveAt: null,
    isPending: false,
  };
  const result = check(
    command([
      { accountId: "acct_elsewhere", direction: "DEBIT", amount: money("USD", 500n), memo: "d" },
      { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: money("USD", 500n), memo: "c" },
    ]),
    { accounts: new Map([...accounts, ["acct_elsewhere", foreign]]) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "FOREIGN_LEDGER");
});

test("J13 a backdated journal into a closed period is refused", () => {
  const result = check(command(balanced, { effectiveAt: "2026-01-15" }), {
    closedThrough: "2026-01-31",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.rejection.code, "PERIOD_CLOSED");
});

test("J14 a backdated journal into an open period is accepted", () => {
  const result = check(command(balanced, { effectiveAt: "2026-02-01" }), {
    closedThrough: "2026-01-31",
  });
  assert.equal(result.ok, true);
});

test("J15 identity is derived from content, so validating twice gives the same ids", () => {
  const a = check(command(balanced));
  const b = check(command(balanced));
  assert.equal(a.ok && b.ok && a.journalId === b.journalId, true);
  assert.equal(a.ok ? a.journalId : "", deriveJournalId(LEDGER_ID, "ref-1"));
  if (a.ok) {
    assert.equal(a.postings[0]?.postingId, derivePostingId(a.journalId, 1));
    assert.equal(a.postings[1]?.postingId, derivePostingId(a.journalId, 2));
  }
});

test("J16 netByCurrency keeps currencies apart", () => {
  const net = netByCurrency([
    { direction: "DEBIT", amount: { currency: "USD", minor: 100n } },
    { direction: "CREDIT", amount: { currency: "EUR", minor: 100n } },
  ]);
  assert.equal(net.get("USD"), 100n);
  assert.equal(net.get("EUR"), -100n);
});
