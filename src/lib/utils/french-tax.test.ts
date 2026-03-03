import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend, makeEntry, makeLineItem } from "../../test/helpers.js";
import type { Account, Currency } from "$lib/types/index.js";
import {
  classifyEntryEvent,
  computeFrenchTaxReport,
  DEFAULT_FIAT_CURRENCIES,
  type FrenchTaxOptions,
} from "./french-tax.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

// ---- Test helpers ----

async function createCryptoTaxBackend() {
  const backend = await createTestBackend();

  // Currencies
  const EUR: Currency = { code: "EUR", asset_type: "", param: "", name: "Euro", decimal_places: 2, is_base: true };
  const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: false };
  const BTC: Currency = { code: "BTC", asset_type: "", param: "", name: "Bitcoin", decimal_places: 8, is_base: false };
  const ETH: Currency = { code: "ETH", asset_type: "", param: "", name: "Ethereum", decimal_places: 18, is_base: false };
  const USDT: Currency = { code: "USDT", asset_type: "", param: "", name: "Tether", decimal_places: 6, is_base: false };
  await backend.createCurrency(EUR);
  await backend.createCurrency(USD);
  await backend.createCurrency(BTC);
  await backend.createCurrency(ETH);
  await backend.createCurrency(USDT);

  // Parent accounts
  const assetsId = uuidv7();
  await backend.createAccount({
    id: assetsId, parent_id: null, account_type: "asset",
    name: "Assets", full_name: "Assets",
    allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
  });
  const equityId = uuidv7();
  await backend.createAccount({
    id: equityId, parent_id: null, account_type: "equity",
    name: "Equity", full_name: "Equity",
    allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
  });
  const expensesId = uuidv7();
  await backend.createAccount({
    id: expensesId, parent_id: null, account_type: "expense",
    name: "Expenses", full_name: "Expenses",
    allowed_currencies: [], is_postable: false, is_archived: false, created_at: "2024-01-01",
  });

  // Postable accounts
  const bank = await createPostable(backend, assetsId, "asset", "Bank", "Assets:Bank");
  const crypto = await createPostable(backend, assetsId, "asset", "Crypto", "Assets:Crypto");
  const tradingEUR = await createPostable(backend, equityId, "equity", "Trading:EUR", "Equity:Trading:EUR");
  const tradingBTC = await createPostable(backend, equityId, "equity", "Trading:BTC", "Equity:Trading:BTC");
  const tradingETH = await createPostable(backend, equityId, "equity", "Trading:ETH", "Equity:Trading:ETH");
  const tradingUSD = await createPostable(backend, equityId, "equity", "Trading:USD", "Equity:Trading:USD");
  const tradingUSDT = await createPostable(backend, equityId, "equity", "Trading:USDT", "Equity:Trading:USDT");
  const fees = await createPostable(backend, expensesId, "expense", "Fees", "Expenses:Fees");

  return {
    backend, EUR, USD, BTC, ETH, USDT,
    accounts: { bank, crypto, tradingEUR, tradingBTC, tradingETH, tradingUSD, tradingUSDT, fees },
  };
}

async function createPostable(
  backend: SqlJsBackend,
  parentId: string,
  type: Account["account_type"],
  name: string,
  fullName: string,
): Promise<Account> {
  const acc: Account = {
    id: uuidv7(), parent_id: parentId, account_type: type,
    name, full_name: fullName,
    allowed_currencies: [], is_postable: true, is_archived: false, created_at: "2024-01-01",
  };
  await backend.createAccount(acc);
  return acc;
}

function buildAccountMap(accounts: Record<string, Account>): Map<string, Account> {
  const map = new Map<string, Account>();
  for (const acc of Object.values(accounts)) {
    map.set(acc.id, acc);
  }
  return map;
}

// ---- Tests ----

describe("classifyEntryEvent", () => {
  it("detects crypto-to-fiat disposition via Equity:Trading pattern", async () => {
    const { accounts } = await createCryptoTaxBackend();
    const accountMap = buildAccountMap(accounts);
    const entry = makeEntry({ date: "2024-06-01", description: "Sell BTC for EUR" });

    // BTC leaves crypto account, EUR arrives in bank
    // Via trading accounts: Equity:Trading:BTC absorbs BTC (positive), Equity:Trading:EUR emits EUR (negative)
    const items = [
      makeLineItem(entry.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(entry.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(entry.id, accounts.tradingEUR.id, "EUR", "-50000"),
      makeLineItem(entry.id, accounts.bank.id, "EUR", "50000"),
    ];

    const event = classifyEntryEvent(entry, items, accountMap, DEFAULT_FIAT_CURRENCIES);
    expect(event.type).toBe("disposition");
    expect(event.fiatAmountEUR.toNumber()).toBe(50000);
    expect(event.cryptoCurrencies).toContain("BTC");
  });

  it("detects fiat-to-crypto acquisition", async () => {
    const { accounts } = await createCryptoTaxBackend();
    const accountMap = buildAccountMap(accounts);
    const entry = makeEntry({ date: "2024-03-01", description: "Buy BTC with EUR" });

    const items = [
      makeLineItem(entry.id, accounts.bank.id, "EUR", "-10000"),
      makeLineItem(entry.id, accounts.tradingEUR.id, "EUR", "10000"),
      makeLineItem(entry.id, accounts.tradingBTC.id, "BTC", "-0.5"),
      makeLineItem(entry.id, accounts.crypto.id, "BTC", "0.5"),
    ];

    const event = classifyEntryEvent(entry, items, accountMap, DEFAULT_FIAT_CURRENCIES);
    expect(event.type).toBe("acquisition");
    expect(event.fiatAmountEUR.toNumber()).toBe(10000);
    expect(event.cryptoCurrencies).toContain("BTC");
  });

  it("crypto-to-crypto swap is not taxable", async () => {
    const { accounts } = await createCryptoTaxBackend();
    const accountMap = buildAccountMap(accounts);
    const entry = makeEntry({ date: "2024-04-01", description: "Swap BTC for ETH" });

    const items = [
      makeLineItem(entry.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(entry.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(entry.id, accounts.tradingETH.id, "ETH", "-20"),
      makeLineItem(entry.id, accounts.crypto.id, "ETH", "20"),
    ];

    const event = classifyEntryEvent(entry, items, accountMap, DEFAULT_FIAT_CURRENCIES);
    expect(event.type).toBe("none");
  });

  it("stablecoin swap is not taxable (USDT not in fiat list)", async () => {
    const { accounts } = await createCryptoTaxBackend();
    const accountMap = buildAccountMap(accounts);
    const entry = makeEntry({ date: "2024-05-01", description: "Swap BTC for USDT" });

    const items = [
      makeLineItem(entry.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(entry.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(entry.id, accounts.tradingUSDT.id, "USDT", "-50000"),
      makeLineItem(entry.id, accounts.crypto.id, "USDT", "50000"),
    ];

    const event = classifyEntryEvent(entry, items, accountMap, DEFAULT_FIAT_CURRENCIES);
    expect(event.type).toBe("none");
  });

  it("deducts fiat fees from disposition proceeds", async () => {
    const { accounts } = await createCryptoTaxBackend();
    const accountMap = buildAccountMap(accounts);
    const entry = makeEntry({ date: "2024-06-01", description: "Sell BTC with fee" });

    const items = [
      makeLineItem(entry.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(entry.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(entry.id, accounts.tradingEUR.id, "EUR", "-50000"),
      makeLineItem(entry.id, accounts.bank.id, "EUR", "49950"),
      makeLineItem(entry.id, accounts.fees.id, "EUR", "50"),
    ];

    const event = classifyEntryEvent(entry, items, accountMap, DEFAULT_FIAT_CURRENCIES);
    expect(event.type).toBe("disposition");
    expect(event.fiatAmountEUR.toNumber()).toBe(49950);
  });
});

describe("computeFrenchTaxReport", () => {
  it("single buy + single sell: verify formula", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 1 BTC for 10,000 EUR on 2024-03-01
    const buy = makeEntry({ date: "2024-03-01", description: "Buy BTC" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-10000"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "10000"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "1"),
    ]);

    // Record BTC/EUR rate for sale date
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "50000", source: "manual",
    });

    // Sell 1 BTC for 50,000 EUR on 2024-06-01
    const sell = makeEntry({ date: "2024-06-01", description: "Sell BTC" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-50000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "50000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(1);
    const d = report.dispositions[0];

    // C = 50000, A = 10000, V = portfolio value at sale date
    // Since trial balance is "as of" (exclusive), BTC was already sold by that point
    // The trial balance will show 0 BTC if the sale entry is already posted
    // But V should reflect the portfolio BEFORE the sale...
    // Actually, trial balance queries date < asOf, so with asOf = "2024-06-01" we get balance BEFORE June 1
    // The buy was on March 1, and there's 1 BTC * 50000 rate = 50000 EUR
    expect(d.fiatReceived).toBe("50000.00");
    expect(d.acquisitionCostBefore).toBe("10000.00");
    // V = 50000 (1 BTC at 50000 EUR/BTC)
    expect(d.portfolioValue).toBe("50000.00");
    // costFraction = A * C / V = 10000 * 50000 / 50000 = 10000
    expect(d.costFraction).toBe("10000.00");
    // plusValue = C - costFraction = 50000 - 10000 = 40000
    expect(d.plusValue).toBe("40000.00");

    expect(report.totalPlusValue).toBe("40000.00");
    expect(report.box3AN).toBe("40000.00");
    expect(report.box3BN).toBe("0.00");
    expect(report.isExempt).toBe(false);
  });

  it("multiple acquisitions, single sale", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 1 BTC for 10,000 EUR
    const buy1 = makeEntry({ date: "2024-01-15", description: "Buy BTC #1" });
    await backend.postJournalEntry(buy1, [
      makeLineItem(buy1.id, accounts.bank.id, "EUR", "-10000"),
      makeLineItem(buy1.id, accounts.tradingEUR.id, "EUR", "10000"),
      makeLineItem(buy1.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy1.id, accounts.crypto.id, "BTC", "1"),
    ]);

    // Buy 1 more BTC for 20,000 EUR
    const buy2 = makeEntry({ date: "2024-03-01", description: "Buy BTC #2" });
    await backend.postJournalEntry(buy2, [
      makeLineItem(buy2.id, accounts.bank.id, "EUR", "-20000"),
      makeLineItem(buy2.id, accounts.tradingEUR.id, "EUR", "20000"),
      makeLineItem(buy2.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy2.id, accounts.crypto.id, "BTC", "1"),
    ]);

    // BTC/EUR rate for sale date: 40000
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "40000", source: "manual",
    });

    // Sell 1 BTC for 40,000 EUR
    const sell = makeEntry({ date: "2024-06-01", description: "Sell BTC" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-40000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "40000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(1);
    const d = report.dispositions[0];

    // A = 10000 + 20000 = 30000
    // C = 40000
    // V = portfolio at sale date = 2 BTC * 40000 = 80000
    expect(d.acquisitionCostBefore).toBe("30000.00");
    expect(d.fiatReceived).toBe("40000.00");
    expect(d.portfolioValue).toBe("80000.00");
    // costFraction = 30000 * 40000 / 80000 = 15000
    expect(d.costFraction).toBe("15000.00");
    // plusValue = 40000 - 15000 = 25000
    expect(d.plusValue).toBe("25000.00");
    // A after = 30000 - 15000 = 15000
    expect(d.acquisitionCostAfter).toBe("15000.00");
    expect(report.finalAcquisitionCost).toBe("15000.00");
  });

  it("sale at a loss", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 1 BTC for 50,000 EUR
    const buy = makeEntry({ date: "2024-02-01", description: "Buy BTC" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-50000"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "50000"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "1"),
    ]);

    // BTC drops to 30,000
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-08-01", from_currency: "BTC", to_currency: "EUR",
      rate: "30000", source: "manual",
    });

    // Sell 1 BTC for 30,000 EUR
    const sell = makeEntry({ date: "2024-08-01", description: "Sell BTC at loss" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-30000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "30000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    const d = report.dispositions[0];
    // A = 50000, C = 30000, V = 30000 (1 BTC)
    // costFraction = 50000 * 30000 / 30000 = 50000
    // But costFraction > A edge case doesn't apply here since costFraction == A
    expect(d.costFraction).toBe("50000.00");
    // plusValue = 30000 - 50000 = -20000
    expect(d.plusValue).toBe("-20000.00");
    expect(report.box3AN).toBe("0.00");
    expect(report.box3BN).toBe("20000.00");
  });

  it("prior acquisition cost override", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // No buy recorded in dledger — user specifies prior A
    // Just have 1 BTC in the crypto account via opening balance
    const opening = makeEntry({ date: "2023-12-01", description: "Opening BTC balance" });
    // Simulate: we need an equity account for opening balance
    await backend.postJournalEntry(opening, [
      makeLineItem(opening.id, accounts.crypto.id, "BTC", "1"),
      makeLineItem(opening.id, accounts.tradingBTC.id, "BTC", "-1"),
    ]);

    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "60000", source: "manual",
    });

    // Sell 1 BTC for 60,000 EUR
    const sell = makeEntry({ date: "2024-06-01", description: "Sell BTC" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-60000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "60000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "25000", // User bought BTC for 25k EUR before dledger
    });

    expect(report.dispositions).toHaveLength(1);
    const d = report.dispositions[0];
    // A = 25000 (prior), C = 60000, V = 60000 (1 BTC at 60k)
    expect(d.acquisitionCostBefore).toBe("25000.00");
    // costFraction = 25000 * 60000 / 60000 = 25000
    expect(d.costFraction).toBe("25000.00");
    // plusValue = 60000 - 25000 = 35000
    expect(d.plusValue).toBe("35000.00");
  });

  it("multiple sales same day: A updates between them, V cached", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 2 BTC for 20,000 EUR each
    const buy = makeEntry({ date: "2024-02-01", description: "Buy 2 BTC" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-40000"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "40000"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-2"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "2"),
    ]);

    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-07-01", from_currency: "BTC", to_currency: "EUR",
      rate: "50000", source: "manual",
    });

    // Sell 1 BTC for 50,000 EUR
    const sell1 = makeEntry({ date: "2024-07-01", description: "Sell BTC #1", created_at: "2024-07-01T10:00:00" });
    await backend.postJournalEntry(sell1, [
      makeLineItem(sell1.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell1.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell1.id, accounts.tradingEUR.id, "EUR", "-50000"),
      makeLineItem(sell1.id, accounts.bank.id, "EUR", "50000"),
    ]);

    // Sell another 1 BTC for 50,000 EUR same day
    const sell2 = makeEntry({ date: "2024-07-01", description: "Sell BTC #2", created_at: "2024-07-01T11:00:00" });
    await backend.postJournalEntry(sell2, [
      makeLineItem(sell2.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell2.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell2.id, accounts.tradingEUR.id, "EUR", "-50000"),
      makeLineItem(sell2.id, accounts.bank.id, "EUR", "50000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(2);

    // First sale: A = 40000, C = 50000, V = 100000 (2 BTC * 50000)
    const d1 = report.dispositions[0];
    expect(d1.acquisitionCostBefore).toBe("40000.00");
    expect(d1.portfolioValue).toBe("100000.00");
    // costFraction = 40000 * 50000 / 100000 = 20000
    expect(d1.costFraction).toBe("20000.00");
    // plusValue = 50000 - 20000 = 30000
    expect(d1.plusValue).toBe("30000.00");

    // Second sale: A = 40000 - 20000 = 20000 (updated!), V still 100000 (cached)
    const d2 = report.dispositions[1];
    expect(d2.acquisitionCostBefore).toBe("20000.00");
    // costFraction = 20000 * 50000 / 100000 = 10000
    expect(d2.costFraction).toBe("10000.00");
    // plusValue = 50000 - 10000 = 40000
    expect(d2.plusValue).toBe("40000.00");

    // Total = 30000 + 40000 = 70000
    expect(report.totalPlusValue).toBe("70000.00");
  });

  it("non-EUR fiat sale (USD→EUR conversion)", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 1 BTC for 10,000 USD
    const buy = makeEntry({ date: "2024-03-01", description: "Buy BTC with USD" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "USD", "-10000"),
      makeLineItem(buy.id, accounts.tradingUSD.id, "USD", "10000"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "1"),
    ]);

    // USD/EUR rate for buy date
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-03-01", from_currency: "USD", to_currency: "EUR",
      rate: "0.92", source: "manual",
    });

    // BTC/EUR rate for sale date
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "BTC", to_currency: "EUR",
      rate: "50000", source: "manual",
    });

    // USD/EUR rate for sale date
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-06-01", from_currency: "USD", to_currency: "EUR",
      rate: "0.93", source: "manual",
    });

    // Sell 1 BTC for 54,000 USD
    const sell = makeEntry({ date: "2024-06-01", description: "Sell BTC for USD" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-1"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "1"),
      makeLineItem(sell.id, accounts.tradingUSD.id, "USD", "-54000"),
      makeLineItem(sell.id, accounts.bank.id, "USD", "54000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(1);
    // Acquisition: 10000 USD * 0.92 = 9200 EUR
    // A after buy = 9200
    const d = report.dispositions[0];
    expect(d.acquisitionCostBefore).toBe("9200.00");
    // C = 54000 USD * 0.93 = 50220 EUR
    expect(d.fiatReceived).toBe("50220.00");
    // V = 1 BTC * 50000 = 50000 EUR
    expect(d.portfolioValue).toBe("50000.00");
  });

  it("305 EUR exemption threshold", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy some BTC
    const buy = makeEntry({ date: "2024-02-01", description: "Buy BTC" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-200"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "200"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-0.01"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "0.01"),
    ]);

    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-09-01", from_currency: "BTC", to_currency: "EUR",
      rate: "25000", source: "manual",
    });

    // Sell for 250 EUR (under 305 threshold)
    const sell = makeEntry({ date: "2024-09-01", description: "Sell BTC small" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "BTC", "-0.01"),
      makeLineItem(sell.id, accounts.tradingBTC.id, "BTC", "0.01"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-250"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "250"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    // Total dispositions = 250 EUR < 305 → exempt
    expect(report.isExempt).toBe(true);
    expect(report.taxDuePFU30).toBe("0.00");
    expect(report.taxDuePFU314).toBe("0.00");
  });

  it("missing exchange rate generates warning", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Buy 1 ETH
    const buy = makeEntry({ date: "2024-03-01", description: "Buy ETH" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-3000"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "3000"),
      makeLineItem(buy.id, accounts.tradingETH.id, "ETH", "-1"),
      makeLineItem(buy.id, accounts.crypto.id, "ETH", "1"),
    ]);

    // Sell but don't record any ETH/EUR rate
    const sell = makeEntry({ date: "2024-06-01", description: "Sell ETH" });
    await backend.postJournalEntry(sell, [
      makeLineItem(sell.id, accounts.crypto.id, "ETH", "-1"),
      makeLineItem(sell.id, accounts.tradingETH.id, "ETH", "1"),
      makeLineItem(sell.id, accounts.tradingEUR.id, "EUR", "-4000"),
      makeLineItem(sell.id, accounts.bank.id, "EUR", "4000"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    // Should have a warning about missing ETH/EUR rate
    expect(report.warnings.some(w => w.includes("ETH/EUR"))).toBe(true);
  });

  it("no dispositions produces empty report", async () => {
    const { backend, accounts } = await createCryptoTaxBackend();

    // Only buy, no sell
    const buy = makeEntry({ date: "2024-03-01", description: "Buy BTC" });
    await backend.postJournalEntry(buy, [
      makeLineItem(buy.id, accounts.bank.id, "EUR", "-10000"),
      makeLineItem(buy.id, accounts.tradingEUR.id, "EUR", "10000"),
      makeLineItem(buy.id, accounts.tradingBTC.id, "BTC", "-1"),
      makeLineItem(buy.id, accounts.crypto.id, "BTC", "1"),
    ]);

    const report = await computeFrenchTaxReport(backend, {
      taxYear: 2024,
      priorAcquisitionCost: "0",
    });

    expect(report.dispositions).toHaveLength(0);
    expect(report.totalPlusValue).toBe("0.00");
    expect(report.finalAcquisitionCost).toBe("10000.00");
    expect(report.acquisitions).toHaveLength(1);
  });
});
