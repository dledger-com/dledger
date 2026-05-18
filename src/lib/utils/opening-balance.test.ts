import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend, makeEntry, makeLineItem } from "../../test/helpers.js";
import type { Account, Currency } from "$lib/types/index.js";
import {
  postOpeningBalanceEntry,
  ensureOpeningBalancesAccount,
  listOpeningBalanceEntries,
  entryCostEUR,
  invalidateFrenchTaxChainFromYear,
  OPENING_BALANCE_SOURCE,
  OPENING_BALANCE_EQUITY_PATH,
} from "./opening-balance.js";
import { computeFrenchTaxReport } from "./french-tax.js";

async function setupBackend() {
  const backend = await createTestBackend();

  const EUR: Currency = { code: "EUR", asset_type: "", name: "Euro", decimal_places: 2 };
  const BTC: Currency = { code: "BTC", asset_type: "", name: "Bitcoin", decimal_places: 8 };
  await backend.createCurrency(EUR);
  await backend.createCurrency(BTC);

  const assetsId = uuidv7();
  await backend.createAccount({
    id: assetsId, parent_id: null, account_type: "asset",
    name: "Assets", full_name: "Assets",
    allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
  });
  const cryptoBtc: Account = {
    id: uuidv7(), parent_id: assetsId, account_type: "asset",
    name: "BTC", full_name: "Assets:Crypto:BTC",
    allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
  };
  await backend.createAccount(cryptoBtc);

  // Equity parent — children get auto-created by the helper
  const equityId = uuidv7();
  await backend.createAccount({
    id: equityId, parent_id: null, account_type: "equity",
    name: "Equity", full_name: "Equity",
    allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
  });
  const tradingEUR: Account = {
    id: uuidv7(), parent_id: equityId, account_type: "equity",
    name: "Trading:EUR", full_name: "Equity:Trading:EUR",
    allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
  };
  await backend.createAccount(tradingEUR);
  const tradingBTC: Account = {
    id: uuidv7(), parent_id: equityId, account_type: "equity",
    name: "Trading:BTC", full_name: "Equity:Trading:BTC",
    allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
  };
  await backend.createAccount(tradingBTC);
  const bank: Account = {
    id: uuidv7(), parent_id: assetsId, account_type: "asset",
    name: "Bank", full_name: "Assets:Bank",
    allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
  };
  await backend.createAccount(bank);

  return { backend, accounts: { cryptoBtc, tradingEUR, tradingBTC, bank } };
}

describe("ensureOpeningBalancesAccount", () => {
  it("creates Equity:Opening-Balances and its parents if missing", async () => {
    const backend = await createTestBackend();
    const id = await ensureOpeningBalancesAccount(backend, "2024-01-01");
    expect(id).toBeTruthy();
    const all = await backend.listAccounts();
    const equity = all.find(a => a.full_name === OPENING_BALANCE_EQUITY_PATH);
    expect(equity).toBeDefined();
    expect(equity!.account_type).toBe("equity");
    expect(equity!.is_postable).toBe(true);
    // Parent "Equity" was auto-created
    expect(all.find(a => a.full_name === "Equity")).toBeDefined();
  });

  it("is idempotent — returns the same id on repeated calls", async () => {
    const backend = await createTestBackend();
    const id1 = await ensureOpeningBalancesAccount(backend, "2024-01-01");
    const id2 = await ensureOpeningBalancesAccount(backend, "2024-01-01");
    expect(id1).toBe(id2);
  });
});

describe("postOpeningBalanceEntry", () => {
  it("posts entry with costEUR and is recognized by the tax engine as an acquisition", async () => {
    const { backend, accounts } = await setupBackend();

    await postOpeningBalanceEntry(backend, {
      date: "2018-12-31",
      positions: [{ accountId: accounts.cryptoBtc.id, currency: "BTC", quantity: "0.5" }],
      costEUR: "10000",
    });

    // 2024 sale to verify A picks up the opening cost
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "60000", source: "manual",
    });
    const sell = makeEntry({ date: "2024-06-01", description: "Sell 0.1 BTC" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.cryptoBtc.id, "BTC", "-0.1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "0.1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-6000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "6000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(1);
    expect(report.dispositions[0].acquisitionCostBefore).toBe("10000.00");
    // V = 0.5 BTC * 60000 = 30000
    expect(report.dispositions[0].portfolioValue).toBe("30000.00");
  });

  it("posts entry without costEUR as a pure pad (no acquisition)", async () => {
    const { backend, accounts } = await setupBackend();

    await postOpeningBalanceEntry(backend, {
      date: "2018-12-31",
      positions: [{ accountId: accounts.cryptoBtc.id, currency: "BTC", quantity: "0.5" }],
    });

    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "60000", source: "manual",
    });
    const sell = makeEntry({ date: "2024-06-01", description: "Sell 0.1 BTC" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.cryptoBtc.id, "BTC", "-0.1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "0.1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-6000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "6000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    // No acquisition recorded → A = 0, but V still includes the BTC.
    expect(report.dispositions[0].acquisitionCostBefore).toBe("0.00");
    expect(report.dispositions[0].portfolioValue).toBe("30000.00");
  });

  it("uses source = system:opening-balance and description_data.type = opening-balance", async () => {
    const { backend, accounts } = await setupBackend();

    await postOpeningBalanceEntry(backend, {
      date: "2018-12-31",
      positions: [{ accountId: accounts.cryptoBtc.id, currency: "BTC", quantity: "0.5" }],
      costEUR: "10000",
      note: "Coinbase 2017",
    });

    const entries = await listOpeningBalanceEntries(backend);
    expect(entries).toHaveLength(1);
    const [entry] = entries[0];
    expect(entry.source).toBe(OPENING_BALANCE_SOURCE);
    const data = JSON.parse(entry.description_data || "{}");
    expect(data.type).toBe("opening-balance");
    expect(data.costEUR).toBe("10000");
    expect(data.note).toBe("Coinbase 2017");
  });

  it("balanced double-entry: equity counter cancels the asset side", async () => {
    const { backend, accounts } = await setupBackend();

    await postOpeningBalanceEntry(backend, {
      date: "2018-12-31",
      positions: [{ accountId: accounts.cryptoBtc.id, currency: "BTC", quantity: "0.5" }],
      costEUR: "10000",
    });

    const [[, items]] = await listOpeningBalanceEntries(backend);
    expect(items).toHaveLength(2);
    const total = items.reduce((acc, it) => acc + parseFloat(it.amount), 0);
    expect(total).toBeCloseTo(0, 10);
  });

  it("entryCostEUR returns '0' for entries without declared cost", async () => {
    const { backend, accounts } = await setupBackend();

    await postOpeningBalanceEntry(backend, {
      date: "2018-12-31",
      positions: [{ accountId: accounts.cryptoBtc.id, currency: "BTC", quantity: "0.5" }],
    });

    const [[entry]] = await listOpeningBalanceEntries(backend);
    expect(entryCostEUR(entry)).toBe("0");
  });
});

describe("invalidateFrenchTaxChainFromYear", () => {
  it("deletes persisted reports for years >= the given year, keeps earlier ones", async () => {
    const backend = await createTestBackend();
    // Seed three years of persisted reports
    const stubReport = {
      taxYear: 0, dispositions: [], acquisitions: [],
      totalPlusValue: "0.00", totalFiatReceived: "0.00", finalAcquisitionCost: "0.00",
      yearEndPortfolioValue: "0.00", box3AN: "0.00", box3BN: "0.00",
      isExempt: true, taxDuePFU30: "0.00", taxDuePFU314: "0.00",
      warnings: [], skippedDispositionCount: 0, missingCurrencyDates: [],
      entriesProcessed: 0, preYearAcquisitionCount: 0, preYearAcquisitionTotal: "0.00",
      preYearDispositionCount: 0, preYearDispositionTotal: "0.00",
      preYearDispositionSamples: [], yearEndCryptoHoldings: [],
    };
    await backend.saveFrenchTaxReport(2021, { ...stubReport, taxYear: 2021 });
    await backend.saveFrenchTaxReport(2022, { ...stubReport, taxYear: 2022 });
    await backend.saveFrenchTaxReport(2023, { ...stubReport, taxYear: 2023 });

    await invalidateFrenchTaxChainFromYear(backend, "2022-05-01");

    const years = await backend.listFrenchTaxReportYears();
    expect(years.sort()).toEqual([2021]);
  });
});
