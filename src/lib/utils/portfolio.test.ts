import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import { computePortfolioReport } from "./portfolio.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { Account, Currency } from "$lib/types/index.js";

describe("computePortfolioReport", () => {
  let backend: SqlJsBackend;
  let USD: Currency;
  let ETH: Currency;

  async function createAccountHierarchy(
    fullName: string,
    accountType: "asset" | "expense" | "revenue" | "equity" | "liability",
    parentId: string | null,
  ): Promise<Account> {
    const parts = fullName.split(":");
    const name = parts[parts.length - 1];
    const acc: Account = {
      id: uuidv7(),
      parent_id: parentId,
      account_type: accountType,
      name,
      full_name: fullName,
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(acc);
    return acc;
  }

  beforeEach(async () => {
    backend = await createTestBackend();

    USD = { code: "USD", asset_type: "", name: "US Dollar", decimal_places: 2, is_base: true };
    ETH = { code: "ETH", asset_type: "", name: "Ether", decimal_places: 18, is_base: false };
    await backend.createCurrency(USD);
    await backend.createCurrency(ETH);
  });

  it("returns empty report when no etherscan accounts exist", async () => {
    const report = await computePortfolioReport(backend, "USD", "2024-12-31");

    expect(report.as_of).toBe("2024-12-31");
    expect(report.base_currency).toBe("USD");
    expect(report.wallets).toHaveLength(0);
    expect(report.aggregate_total).toBeNull();
  });

  it("reports holdings for a single wallet", async () => {
    // Set up etherscan account
    await backend.addEtherscanAccount("0xabc", 1, "MyWallet");

    // Create asset accounts matching the label
    const assets = await createAccountHierarchy("Assets", "asset", null);
    assets.is_postable = false;
    const ethAcc = await createAccountHierarchy(
      "Assets:Crypto:MyWallet",
      "asset",
      assets.id,
    );

    // Create equity for balancing
    const equity = await createAccountHierarchy("Equity", "equity", null);
    const opening = await createAccountHierarchy(
      "Equity:Opening",
      "equity",
      equity.id,
    );

    // Post a journal entry: 2 ETH in the wallet
    const entryId = uuidv7();
    await backend.postJournalEntry(
      {
        id: entryId,
        date: "2024-06-01",
        description: "Deposit",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: ethAcc.id,
          currency: "ETH",
          amount: "2",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: opening.id,
          currency: "ETH",
          amount: "-2",
          lot_id: null,
        },
      ],
    );

    // Record exchange rate: 1 ETH = 3000 USD
    await backend.recordExchangeRate({
      id: uuidv7(),
      date: "2024-12-31",
      from_currency: "ETH",
      to_currency: "USD",
      rate: "3000",
      source: "manual",
    });

    const report = await computePortfolioReport(backend, "USD", "2024-12-31");

    expect(report.wallets).toHaveLength(1);
    expect(report.wallets[0].label).toBe("MyWallet");
    expect(report.wallets[0].address).toBe("0xabc");
    expect(report.wallets[0].chainId).toBe(1);
    expect(report.wallets[0].holdings).toHaveLength(1);
    expect(report.wallets[0].holdings[0].currency).toBe("ETH");
    expect(report.wallets[0].holdings[0].amount).toBe("2");
    expect(report.wallets[0].holdings[0].baseValue).toBe("6000.00");
    expect(report.wallets[0].totalBaseValue).toBe("6000.00");
    expect(report.aggregate_total).toBe("6000.00");
  });

  it("aggregates totals across multiple wallets", async () => {
    // Set up two etherscan accounts with different labels
    await backend.addEtherscanAccount("0xabc", 1, "Wallet1");
    await backend.addEtherscanAccount("0xdef", 1, "Wallet2");

    const assets = await createAccountHierarchy("Assets", "asset", null);
    assets.is_postable = false;
    const acc1 = await createAccountHierarchy(
      "Assets:Crypto:Wallet1",
      "asset",
      assets.id,
    );
    const acc2 = await createAccountHierarchy(
      "Assets:Crypto:Wallet2",
      "asset",
      assets.id,
    );

    const equity = await createAccountHierarchy("Equity", "equity", null);
    const opening = await createAccountHierarchy(
      "Equity:Opening",
      "equity",
      equity.id,
    );

    // Wallet1: 500 USD
    const e1 = uuidv7();
    await backend.postJournalEntry(
      {
        id: e1,
        date: "2024-06-01",
        description: "Deposit 1",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: e1,
          account_id: acc1.id,
          currency: "USD",
          amount: "500",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: e1,
          account_id: opening.id,
          currency: "USD",
          amount: "-500",
          lot_id: null,
        },
      ],
    );

    // Wallet2: 300 USD
    const e2 = uuidv7();
    await backend.postJournalEntry(
      {
        id: e2,
        date: "2024-06-01",
        description: "Deposit 2",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: e2,
          account_id: acc2.id,
          currency: "USD",
          amount: "300",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: e2,
          account_id: opening.id,
          currency: "USD",
          amount: "-300",
          lot_id: null,
        },
      ],
    );

    const report = await computePortfolioReport(backend, "USD", "2024-12-31");

    expect(report.wallets).toHaveLength(2);
    // Sorted by label
    expect(report.wallets[0].label).toBe("Wallet1");
    expect(report.wallets[1].label).toBe("Wallet2");
    expect(report.wallets[0].totalBaseValue).toBe("500.00");
    expect(report.wallets[1].totalBaseValue).toBe("300.00");
    expect(report.aggregate_total).toBe("800.00");
  });

  it("returns null baseValue when exchange rate is missing", async () => {
    await backend.addEtherscanAccount("0xabc", 1, "MyWallet");

    const assets = await createAccountHierarchy("Assets", "asset", null);
    assets.is_postable = false;
    const ethAcc = await createAccountHierarchy(
      "Assets:Crypto:MyWallet",
      "asset",
      assets.id,
    );

    const equity = await createAccountHierarchy("Equity", "equity", null);
    const opening = await createAccountHierarchy(
      "Equity:Opening",
      "equity",
      equity.id,
    );

    // Post ETH holding but NO exchange rate
    const entryId = uuidv7();
    await backend.postJournalEntry(
      {
        id: entryId,
        date: "2024-06-01",
        description: "Deposit",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: ethAcc.id,
          currency: "ETH",
          amount: "5",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: opening.id,
          currency: "ETH",
          amount: "-5",
          lot_id: null,
        },
      ],
    );

    const report = await computePortfolioReport(backend, "USD", "2024-12-31");

    expect(report.wallets).toHaveLength(1);
    expect(report.wallets[0].holdings).toHaveLength(1);
    expect(report.wallets[0].holdings[0].baseValue).toBeNull();
    expect(report.wallets[0].totalBaseValue).toBeNull();
    expect(report.aggregate_total).toBeNull();
  });

  it("excludes hidden currencies from holdings", async () => {
    // Set up etherscan account
    await backend.addEtherscanAccount("0xabc", 1, "MyWallet");

    // Create hierarchy
    const assets = await createAccountHierarchy("Assets", "asset", null);
    assets.is_postable = false;
    const ethAcc = await createAccountHierarchy(
      "Assets:Crypto:MyWallet",
      "asset",
      assets.id,
    );

    const equity = await createAccountHierarchy("Equity", "equity", null);
    const opening = await createAccountHierarchy(
      "Equity:Opening",
      "equity",
      equity.id,
    );

    // Create a spam currency + holding
    const SPAM: Currency = { code: "SPAM", asset_type: "", name: "Spam Token", decimal_places: 18, is_base: false };
    await backend.createCurrency(SPAM);
    await backend.setCurrencyHidden("SPAM", true);

    // Post SPAM holding
    const entryId = uuidv7();
    await backend.postJournalEntry(
      {
        id: entryId,
        date: "2024-06-01",
        description: "Airdrop spam",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: ethAcc.id,
          currency: "SPAM",
          amount: "1000000",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: opening.id,
          currency: "SPAM",
          amount: "-1000000",
          lot_id: null,
        },
      ],
    );

    // Also post a legit ETH holding
    const ethEntryId = uuidv7();
    await backend.postJournalEntry(
      {
        id: ethEntryId,
        date: "2024-06-01",
        description: "ETH deposit",
        status: "confirmed",
        source: "manual",
        voided_by: null,
        created_at: "2024-06-01",
      },
      [
        {
          id: uuidv7(),
          journal_entry_id: ethEntryId,
          account_id: ethAcc.id,
          currency: "ETH",
          amount: "2",
          lot_id: null,
        },
        {
          id: uuidv7(),
          journal_entry_id: ethEntryId,
          account_id: opening.id,
          currency: "ETH",
          amount: "-2",
          lot_id: null,
        },
      ],
    );

    // Request portfolio with SPAM in hiddenCurrencies set
    const report = await computePortfolioReport(
      backend,
      "USD",
      "2024-12-31",
      new Set(["SPAM"]),
    );

    expect(report.wallets).toHaveLength(1);
    // Should only have ETH, not SPAM
    expect(report.wallets[0].holdings).toHaveLength(1);
    expect(report.wallets[0].holdings[0].currency).toBe("ETH");
  });
});
