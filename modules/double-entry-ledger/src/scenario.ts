// One synthetic ledger, built the same way every time.
//
// Tests and `make report` both call this, so what the article prints and what
// the suite asserts are the same ledger. Every figure is invented; no cloud
// project, no provider, no real money.

import { Ledger } from "./ledger.ts";
import { money } from "./money.ts";
import { SpannerModel } from "./spanner.ts";
import type { Account, AccountKind, CurrencyCode, JournalCommand } from "./types.ts";

export const LEDGER_ID = "ldg_platform_demo";

export const ACCOUNTS = {
  clearing: "acct_clearing",
  wallet: "acct_wallet_usd",
  walletPending: "acct_wallet_usd_pending",
  authContra: "acct_auth_contra",
  fee: "acct_processing_fee",
  refunds: "acct_refund_expense",
  bridgeUsd: "acct_fx_bridge_usd",
  bridgeEur: "acct_fx_bridge_eur",
  walletEur: "acct_wallet_eur",
} as const;

function account(
  accountId: string,
  kind: AccountKind,
  currency: CurrencyCode,
  path: string,
  isPending = false,
): Account {
  return {
    accountId,
    ledgerId: LEDGER_ID,
    kind,
    currency,
    path,
    openedEffectiveAt: "2026-01-01",
    closedEffectiveAt: null,
    isPending,
  };
}

export const CHART: readonly Account[] = [
  account(ACCOUNTS.clearing, "ASSET", "USD", "assets/clearing"),
  account(ACCOUNTS.wallet, "LIABILITY", "USD", "liabilities/customer-wallet"),
  account(ACCOUNTS.walletPending, "LIABILITY", "USD", "liabilities/customer-wallet/pending", true),
  account(ACCOUNTS.authContra, "ASSET", "USD", "assets/authorization-contra"),
  account(ACCOUNTS.fee, "REVENUE", "USD", "revenue/processing-fee"),
  account(ACCOUNTS.refunds, "EXPENSE", "USD", "expenses/refunds"),
  account(ACCOUNTS.bridgeUsd, "ASSET", "USD", "assets/fx-bridge"),
  account(ACCOUNTS.bridgeEur, "LIABILITY", "EUR", "liabilities/fx-bridge"),
  account(ACCOUNTS.walletEur, "LIABILITY", "EUR", "liabilities/customer-wallet-eur"),
];

export const BRIDGE_ACCOUNTS = [ACCOUNTS.bridgeUsd, ACCOUNTS.bridgeEur];

const usd = (minor: bigint) => money("USD", minor);
const eur = (minor: bigint) => money("EUR", minor);

/** The journals the demo posts, in order, with the commit tick each takes. */
export const JOURNALS: readonly { tick: number; command: JournalCommand }[] = [
  {
    tick: 10,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "funding-9001",
      effectiveAt: "2026-02-10",
      description: "Customer funds wallet",
      lines: [
        { accountId: ACCOUNTS.clearing, direction: "DEBIT", amount: usd(25_000n), memo: "inbound" },
        { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: usd(25_000n), memo: "wallet credit" },
      ],
    },
  },
  {
    tick: 20,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "auth-9002",
      effectiveAt: "2026-02-11",
      description: "Authorization hold, nothing moved yet",
      lines: [
        { accountId: ACCOUNTS.authContra, direction: "DEBIT", amount: usd(8_000n), memo: "hold" },
        { accountId: ACCOUNTS.walletPending, direction: "CREDIT", amount: usd(8_000n), memo: "held" },
      ],
    },
  },
  {
    tick: 30,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "capture-9002",
      effectiveAt: "2026-02-12",
      description: "Capture: release the hold and move the money",
      lines: [
        { accountId: ACCOUNTS.walletPending, direction: "DEBIT", amount: usd(8_000n), memo: "release" },
        { accountId: ACCOUNTS.authContra, direction: "CREDIT", amount: usd(8_000n), memo: "release" },
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: usd(8_000n), memo: "captured" },
        { accountId: ACCOUNTS.clearing, direction: "CREDIT", amount: usd(8_000n), memo: "settled out" },
      ],
    },
  },
  {
    tick: 40,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "fee-9002",
      effectiveAt: "2026-02-12",
      description: "Processing fee",
      lines: [
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: usd(240n), memo: "fee" },
        { accountId: ACCOUNTS.fee, direction: "CREDIT", amount: usd(240n), memo: "fee" },
      ],
    },
  },
  {
    // Backdated: the refund happened on the 27th of February and the ledger
    // learned about it in March. Effective time and recorded time diverge,
    // and both are kept.
    tick: 50,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "refund-9003",
      effectiveAt: "2026-02-27",
      description: "Refund, learned about late",
      lines: [
        { accountId: ACCOUNTS.refunds, direction: "DEBIT", amount: usd(1_500n), memo: "refund" },
        { accountId: ACCOUNTS.wallet, direction: "CREDIT", amount: usd(1_500n), memo: "refunded" },
      ],
    },
  },
  {
    tick: 60,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "fee-9004",
      effectiveAt: "2026-03-01",
      description: "Fee posted against the wrong account, to be reversed",
      lines: [
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: usd(9_999n), memo: "wrong fee" },
        { accountId: ACCOUNTS.fee, direction: "CREDIT", amount: usd(9_999n), memo: "wrong fee" },
      ],
    },
  },
  {
    tick: 80,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "payout-eur-9005",
      effectiveAt: "2026-03-02",
      description: "Pay a euro wallet, crossing currencies through the bridge",
      lines: [
        { accountId: ACCOUNTS.wallet, direction: "DEBIT", amount: usd(11_000n), memo: "payout" },
        { accountId: ACCOUNTS.bridgeUsd, direction: "CREDIT", amount: usd(11_000n), memo: "bridge out" },
        { accountId: ACCOUNTS.bridgeEur, direction: "DEBIT", amount: eur(10_000n), memo: "bridge in" },
        { accountId: ACCOUNTS.walletEur, direction: "CREDIT", amount: eur(10_000n), memo: "payout" },
      ],
      fxNote: {
        fromCurrency: "USD",
        toCurrency: "EUR",
        rateNumerator: 10_000n,
        rateDenominator: 11_000n,
        rateSource: "synthetic-rate-table/2026-03-02",
      },
    },
  },
  {
    tick: 90,
    command: {
      ledgerId: LEDGER_ID,
      businessRef: "auth-9006",
      effectiveAt: "2026-03-03",
      description: "A second hold, left outstanding on purpose",
      lines: [
        { accountId: ACCOUNTS.authContra, direction: "DEBIT", amount: usd(3_000n), memo: "hold" },
        { accountId: ACCOUNTS.walletPending, direction: "CREDIT", amount: usd(3_000n), memo: "held" },
      ],
    },
  },
];

/** The reversal of the wrong fee, applied after journal `fee-9004`. */
export const REVERSAL = {
  tick: 70,
  of: "fee-9004",
  businessRef: "fee-9004-reversal",
  effectiveAt: "2026-03-01",
  reason: "fee charged against the wrong account",
};

export const AS_OF = "2026-03-31";

/** Build the demo ledger. Deterministic: same inputs, same hashes, every run. */
export function buildScenario(): { readonly db: SpannerModel; readonly ledger: Ledger } {
  const db = new SpannerModel();
  const ledger = new Ledger(db, { ledgerId: LEDGER_ID, bridgeAccountIds: BRIDGE_ACCOUNTS });
  for (const acct of CHART) ledger.openAccount(acct);

  for (const entry of JOURNALS) {
    const result = ledger.post(entry.command, { tick: entry.tick });
    if (result.status !== "ACCEPTED") {
      throw new Error(`scenario journal ${entry.command.businessRef} was rejected: ${result.rejection.code}`);
    }
    if (entry.command.businessRef === REVERSAL.of) {
      const reversal = ledger.reverse(
        result.journal.journalId,
        {
          businessRef: REVERSAL.businessRef,
          effectiveAt: REVERSAL.effectiveAt,
          reason: REVERSAL.reason,
        },
        { tick: REVERSAL.tick },
      );
      if (reversal.status !== "ACCEPTED") {
        throw new Error(`scenario reversal was rejected: ${reversal.rejection.code}`);
      }
    }
  }

  return { db, ledger };
}
