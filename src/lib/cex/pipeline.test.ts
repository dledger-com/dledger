import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import type { CexAdapter, CexLedgerRecord, ExchangeAccount } from "./types.js";
import { syncCexAccount, findEtherscanSourceByTxid, normalizeTxid } from "./pipeline.js";
import type { Account, Currency, JournalEntry, LineItem } from "../types/index.js";

// -- Helpers --

function makeExchangeAccount(overrides: Partial<ExchangeAccount> = {}): ExchangeAccount {
  return {
    id: uuidv7(),
    exchange: "kraken",
    label: "Main Kraken",
    api_key: "test-key",
    api_secret: "test-secret",
    last_sync: null,
    created_at: "2024-01-01",
    ...overrides,
  };
}

function makeMockAdapter(records: CexLedgerRecord[], overrides: Partial<CexAdapter> = {}): CexAdapter {
  return {
    exchangeId: "kraken",
    exchangeName: "Kraken",
    normalizeAsset: (raw: string) => raw,
    fetchLedgerRecords: async () => records,
    ...overrides,
  };
}

function ts(dateStr: string): number {
  return Math.floor(new Date(dateStr + "T12:00:00Z").getTime() / 1000);
}

describe("CEX Pipeline", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
    // Create base currencies
    await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: true });
    await backend.createCurrency({ code: "USD", name: "US Dollar", decimal_places: 2, is_base: false });
  });

  describe("Trade processing", () => {
    it("creates correct line items for a buy trade", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "T001", type: "trade", asset: "EUR", amount: "-10000", fee: "2.50", timestamp: ts("2024-03-15"), txid: null },
        { refid: "T001", type: "trade", asset: "BTC", amount: "0.5", fee: "0", timestamp: ts("2024-03-15"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(1);
      expect(result.entries_skipped).toBe(0);

      const entries = await backend.queryJournalEntries({ source: "kraken:T001" });
      expect(entries).toHaveLength(1);

      const [entry, items] = entries[0];
      expect(entry.source).toBe("kraken:T001");
      expect(entry.date).toBe("2024-03-15");

      // Verify line items (merged by account+currency):
      // Assets:Kraken:EUR = -10000 + -2.50 (fee) = -10002.5
      // Equity:Trading:EUR = 10000
      // Assets:Kraken:BTC = +0.5
      // Equity:Trading:BTC = -0.5
      // Expenses:Kraken:Fees EUR = 2.5
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));

      const itemDetails = items.map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      // Check asset EUR debit (trade + fee merged)
      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:EUR",
        currency: "EUR",
        amount: "-10002.5",
      });

      // Check trading EUR credit (10000)
      expect(itemDetails).toContainEqual({
        account: "Equity:Trading:EUR",
        currency: "EUR",
        amount: "10000",
      });

      // Check asset BTC credit (+0.5)
      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:BTC",
        currency: "BTC",
        amount: "0.5",
      });

      // Check trading BTC debit (-0.5)
      expect(itemDetails).toContainEqual({
        account: "Equity:Trading:BTC",
        currency: "BTC",
        amount: "-0.5",
      });

      // Check fee
      expect(itemDetails).toContainEqual({
        account: "Expenses:Kraken:Fees",
        currency: "EUR",
        amount: "2.5",
      });
    });

    it("creates correct line items for a sell trade", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "T002", type: "trade", asset: "ETH", amount: "-2", fee: "0", timestamp: ts("2024-04-01"), txid: null },
        { refid: "T002", type: "trade", asset: "EUR", amount: "6000", fee: "1.80", timestamp: ts("2024-04-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(1);

      const entries = await backend.queryJournalEntries({ source: "kraken:T002" });
      const [, items] = entries[0];
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));
      const itemDetails = items.map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      // ETH leaves
      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:ETH",
        currency: "ETH",
        amount: "-2",
      });

      // EUR arrives (trade + fee merged: 6000 - 1.80 = 5998.2)
      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:EUR",
        currency: "EUR",
        amount: "5998.2",
      });

      // Fee on EUR
      expect(itemDetails).toContainEqual({
        account: "Expenses:Kraken:Fees",
        currency: "EUR",
        amount: "1.8",
      });
    });

    it("skips trade with single record and warns", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "T003", type: "trade", asset: "EUR", amount: "-100", fee: "0", timestamp: ts("2024-04-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_skipped).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("T003");
    });
  });

  describe("Deposit processing", () => {
    it("creates deposit entry", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "D001", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(1);

      const entries = await backend.queryJournalEntries({ source: "kraken:D001" });
      expect(entries).toHaveLength(1);

      const [, items] = entries[0];
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));

      const itemDetails = items.map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:ETH",
        currency: "ETH",
        amount: "5",
      });
      expect(itemDetails).toContainEqual({
        account: "Equity:Kraken:External",
        currency: "ETH",
        amount: "-5",
      });
    });
  });

  describe("Withdrawal processing", () => {
    it("creates withdrawal entry with fee", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "W001", type: "withdrawal", asset: "BTC", amount: "-0.5", fee: "0.0005", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(1);

      const entries = await backend.queryJournalEntries({ source: "kraken:W001" });
      const [, items] = entries[0];
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));
      const itemDetails = items.map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      // BTC leaves exchange
      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:BTC",
        currency: "BTC",
        amount: "-0.5",
      });

      // External receives (minus fee)
      expect(itemDetails).toContainEqual({
        account: "Equity:Kraken:External",
        currency: "BTC",
        amount: "0.4995",
      });

      // Fee
      expect(itemDetails).toContainEqual({
        account: "Expenses:Kraken:Fees",
        currency: "BTC",
        amount: "0.0005",
      });
    });
  });

  describe("Staking processing", () => {
    it("creates staking reward entry", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "S001", type: "staking", asset: "DOT", amount: "1.5", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(1);

      const entries = await backend.queryJournalEntries({ source: "kraken:S001" });
      const [, items] = entries[0];
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));
      const itemDetails = items.map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      expect(itemDetails).toContainEqual({
        account: "Assets:Kraken:DOT",
        currency: "DOT",
        amount: "1.5",
      });
      expect(itemDetails).toContainEqual({
        account: "Income:Kraken:Staking",
        currency: "DOT",
        amount: "-1.5",
      });
    });
  });

  describe("Transfer processing", () => {
    it("skips internal transfers", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "X001", type: "transfer", asset: "ETH", amount: "1", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(0);
      expect(result.entries_skipped).toBe(1);
    });
  });

  describe("Dedup", () => {
    it("skips already-imported entries on second sync", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "T010", type: "trade", asset: "EUR", amount: "-1000", fee: "0", timestamp: ts("2024-03-15"), txid: null },
        { refid: "T010", type: "trade", asset: "BTC", amount: "0.05", fee: "0", timestamp: ts("2024-03-15"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const adapter = makeMockAdapter(records);

      const result1 = await syncCexAccount(backend, adapter, account);
      expect(result1.entries_imported).toBe(1);

      const result2 = await syncCexAccount(backend, adapter, account);
      expect(result2.entries_imported).toBe(0);
      expect(result2.entries_skipped).toBe(1);
    });
  });

  describe("French tax integration", () => {
    it("buy trade is classified as acquisition by french-tax engine", async () => {
      // Import the classifier
      const { classifyEntryEvent } = await import("../utils/french-tax.js");

      const records: CexLedgerRecord[] = [
        { refid: "FT01", type: "trade", asset: "EUR", amount: "-10002.50", fee: "0", timestamp: ts("2024-03-15"), txid: null },
        { refid: "FT01", type: "trade", asset: "BTC", amount: "0.5", fee: "0", timestamp: ts("2024-03-15"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:FT01" });
      const [entry, items] = entries[0];

      const accounts = await backend.listAccounts();
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const fiatSet = new Set(["EUR", "USD"]);

      const event = classifyEntryEvent(entry, items, accountMap, fiatSet);
      expect(event.type).toBe("acquisition");
      expect(event.fiatAmountEUR.toNumber()).toBeCloseTo(10002.5, 2);
      expect(event.cryptoCurrencies).toContain("BTC");
    });

    it("sell trade is classified as disposition by french-tax engine", async () => {
      const { classifyEntryEvent } = await import("../utils/french-tax.js");

      const records: CexLedgerRecord[] = [
        { refid: "FT02", type: "trade", asset: "ETH", amount: "-2", fee: "0", timestamp: ts("2024-04-01"), txid: null },
        { refid: "FT02", type: "trade", asset: "EUR", amount: "5998.20", fee: "0", timestamp: ts("2024-04-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:FT02" });
      const [entry, items] = entries[0];

      const accounts = await backend.listAccounts();
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const fiatSet = new Set(["EUR", "USD"]);

      const event = classifyEntryEvent(entry, items, accountMap, fiatSet);
      expect(event.type).toBe("disposition");
      expect(event.fiatAmountEUR.toNumber()).toBeCloseTo(5998.2, 2);
    });

    it("crypto-to-crypto trade is classified as none", async () => {
      const { classifyEntryEvent } = await import("../utils/french-tax.js");

      const records: CexLedgerRecord[] = [
        { refid: "FT03", type: "trade", asset: "BTC", amount: "-0.5", fee: "0", timestamp: ts("2024-04-01"), txid: null },
        { refid: "FT03", type: "trade", asset: "ETH", amount: "8", fee: "0", timestamp: ts("2024-04-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:FT03" });
      const [entry, items] = entries[0];

      const accounts = await backend.listAccounts();
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const fiatSet = new Set(["EUR", "USD"]);

      const event = classifyEntryEvent(entry, items, accountMap, fiatSet);
      expect(event.type).toBe("none");
    });

    it("deposit is not taxable", async () => {
      const { classifyEntryEvent } = await import("../utils/french-tax.js");

      const records: CexLedgerRecord[] = [
        { refid: "FT04", type: "deposit", asset: "ETH", amount: "10", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:FT04" });
      const [entry, items] = entries[0];

      const accounts = await backend.listAccounts();
      const accountMap = new Map(accounts.map((a) => [a.id, a]));
      const fiatSet = new Set(["EUR", "USD"]);

      const event = classifyEntryEvent(entry, items, accountMap, fiatSet);
      // Deposit has only equity counterparty, not fiat → should be "none"
      expect(event.type).toBe("none");
    });
  });

  describe("normalizeTxid", () => {
    it("adds 0x prefix to bare hex hashes", () => {
      expect(normalizeTxid("abc123def456abc123def456abc123def456abc123")).toBe(
        "0xabc123def456abc123def456abc123def456abc123",
      );
    });

    it("preserves existing 0x prefix", () => {
      expect(normalizeTxid("0xabc123def456abc123def456abc123def456abc123")).toBe(
        "0xabc123def456abc123def456abc123def456abc123",
      );
    });

    it("lowercases the hash", () => {
      expect(normalizeTxid("0xABC123")).toBe("0xabc123");
    });

    it("lowercases bare hex and adds 0x", () => {
      expect(normalizeTxid("ABC123DEF456ABC123DEF456ABC123DEF456ABC123")).toBe(
        "0xabc123def456abc123def456abc123def456abc123",
      );
    });

    it("passes through non-hex strings", () => {
      expect(normalizeTxid("some-refid")).toBe("some-refid");
    });

    it("passes through short hex strings (less than 40 chars)", () => {
      expect(normalizeTxid("abc123")).toBe("abc123");
    });

    it("trims whitespace", () => {
      expect(normalizeTxid("  0xabc123  ")).toBe("0xabc123");
    });
  });

  describe("findEtherscanSourceByTxid", () => {
    it("finds matching etherscan source", () => {
      const sources = new Set(["etherscan:1:0xabc123", "etherscan:1:0xdef456", "kraken:T001"]);
      expect(findEtherscanSourceByTxid(sources, "0xabc123")).toBe("etherscan:1:0xabc123");
    });

    it("returns null when no match", () => {
      const sources = new Set(["etherscan:1:0xabc123", "kraken:T001"]);
      expect(findEtherscanSourceByTxid(sources, "0xunknown")).toBeNull();
    });

    it("matches case-insensitively", () => {
      const sources = new Set(["etherscan:1:0xABC123"]);
      expect(findEtherscanSourceByTxid(sources, "0xabc123")).toBe("etherscan:1:0xABC123");
    });

    it("matches bare hex txid (without 0x prefix) against 0x-prefixed source", () => {
      // Simulates Kraken returning a txid without 0x prefix
      const sources = new Set(["etherscan:1:0xabc123def456abc123def456abc123def456abc123"]);
      expect(
        findEtherscanSourceByTxid(sources, "abc123def456abc123def456abc123def456abc123"),
      ).toBe("etherscan:1:0xabc123def456abc123def456abc123def456abc123");
    });
  });

  describe("Enrichment warnings", () => {
    it("warns when deposits/withdrawals are missing txid after enrichment", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "EW01", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: null },
        { refid: "EW02", type: "withdrawal", asset: "BTC", amount: "-0.5", fee: "0", timestamp: ts("2024-03-01"), txid: null },
        { refid: "EW03", type: "trade", asset: "EUR", amount: "-100", fee: "0", timestamp: ts("2024-03-01"), txid: null },
        { refid: "EW03", type: "trade", asset: "BTC", amount: "0.01", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      // Should warn about the 2 deposit/withdrawal records missing txid
      const enrichWarning = result.warnings.find((w) => w.includes("could not be enriched"));
      expect(enrichWarning).toBeTruthy();
      expect(enrichWarning).toContain("2 deposit/withdrawal");
    });
  });

  describe("Consolidation", () => {
    it("imports normally when no matching etherscan or CEX entry for txid", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "C001", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xabc123" },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      // No matching source → imports normally
      expect(result.entries_imported).toBe(1);
      expect(result.entries_consolidated).toBe(0);
    });

    it("skips consolidation when txid not found in any existing entries", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "C002", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xnotfound" },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      // No matching etherscan source → imports normally
      expect(result.entries_imported).toBe(1);
      expect(result.entries_consolidated).toBe(0);
    });

    it("stores txid metadata on deposit entries", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "TXM01", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xABC123" },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:TXM01" });
      const meta = await backend.getMetadata(entries[0][0].id);

      expect(meta.txid).toBe("0xabc123"); // lowercased
      expect(meta.exchange).toBe("kraken");
    });

    it("stores txid metadata on withdrawal entries", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "TXM02", type: "withdrawal", asset: "BTC", amount: "-0.5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xDEF456" },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const entries = await backend.queryJournalEntries({ source: "kraken:TXM02" });
      const meta = await backend.getMetadata(entries[0][0].id);

      expect(meta.txid).toBe("0xdef456"); // lowercased
    });

    it("consolidates CEX→CEX when another exchange has matching txid", async () => {
      // Step 1: Simulate a prior "binance" deposit with txid 0xaaa111
      const binanceAdapter = makeMockAdapter(
        [{ refid: "BD01", type: "deposit", asset: "ETH", amount: "5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xaaa111" }],
        { exchangeId: "binance" as never, exchangeName: "Binance" },
      );
      const binanceAccount = makeExchangeAccount({ exchange: "binance" as never, label: "Binance" });
      await backend.addExchangeAccount(binanceAccount);
      await syncCexAccount(backend, binanceAdapter, binanceAccount);

      // Verify binance deposit exists
      const binanceEntries = await backend.queryJournalEntries({ source: "binance:BD01" });
      expect(binanceEntries).toHaveLength(1);

      // Step 2: Sync Kraken with a withdrawal having the same txid
      const krakenRecords: CexLedgerRecord[] = [
        { refid: "KW01", type: "withdrawal", asset: "ETH", amount: "-5", fee: "0", timestamp: ts("2024-03-01"), txid: "0xaaa111" },
      ];
      const krakenAccount = makeExchangeAccount();
      await backend.addExchangeAccount(krakenAccount);
      const result = await syncCexAccount(backend, makeMockAdapter(krakenRecords), krakenAccount);

      // Consolidation should happen
      expect(result.entries_consolidated).toBe(1);
      expect(result.entries_imported).toBe(0);

      // The original binance entry should be voided
      const allEntries = await backend.queryJournalEntries({});
      const binanceVoided = allEntries.find(([e]) => e.source === "binance:BD01" && e.voided_by);
      expect(binanceVoided).toBeTruthy();

      // There should be a new non-voided entry (the remapped one) with binance source
      const remapped = allEntries.find(([e]) => e.source === "binance:BD01" && !e.voided_by);
      expect(remapped).toBeTruthy();

      // The remapped entry should have Assets:Kraken:ETH instead of Equity:Binance:External
      const accounts = await backend.listAccounts();
      const acctMap = new Map(accounts.map((a) => [a.id, a.full_name]));
      const remappedItems = remapped![1].map((i) => ({
        account: acctMap.get(i.account_id),
        currency: i.currency,
        amount: i.amount,
      }));

      // Binance deposit asset account remains
      expect(remappedItems).toContainEqual({
        account: "Assets:Binance:ETH",
        currency: "ETH",
        amount: "5",
      });
      // External account is remapped to Kraken asset
      expect(remappedItems).toContainEqual({
        account: "Assets:Kraken:ETH",
        currency: "ETH",
        amount: "-5",
      });
    });
  });

  describe("Multiple record types in one sync", () => {
    it("processes mixed trades, deposits, and staking", async () => {
      const records: CexLedgerRecord[] = [
        // Trade pair
        { refid: "MIX01", type: "trade", asset: "EUR", amount: "-5000", fee: "1", timestamp: ts("2024-03-01"), txid: null },
        { refid: "MIX01", type: "trade", asset: "ETH", amount: "2", fee: "0", timestamp: ts("2024-03-01"), txid: null },
        // Deposit
        { refid: "MIX02", type: "deposit", asset: "BTC", amount: "1", fee: "0", timestamp: ts("2024-03-05"), txid: null },
        // Staking
        { refid: "MIX03", type: "staking", asset: "DOT", amount: "5", fee: "0", timestamp: ts("2024-03-10"), txid: null },
        // Transfer (skipped)
        { refid: "MIX04", type: "transfer", asset: "ETH", amount: "1", fee: "0", timestamp: ts("2024-03-15"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      const result = await syncCexAccount(backend, makeMockAdapter(records), account);

      expect(result.entries_imported).toBe(3); // trade + deposit + staking
      expect(result.entries_skipped).toBe(1); // transfer
    });
  });

  describe("Account creation", () => {
    it("creates exchange accounts with proper hierarchy", async () => {
      const records: CexLedgerRecord[] = [
        { refid: "AC01", type: "deposit", asset: "ETH", amount: "1", fee: "0", timestamp: ts("2024-03-01"), txid: null },
      ];

      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const accounts = await backend.listAccounts();
      const names = accounts.map((a) => a.full_name);

      expect(names).toContain("Assets:Kraken:ETH");
      expect(names).toContain("Assets:Kraken");
      expect(names).toContain("Equity:Kraken:External");
      expect(names).toContain("Equity:Kraken");
    });
  });

  describe("Last sync update", () => {
    it("updates last_sync on the exchange account", async () => {
      const records: CexLedgerRecord[] = [];
      const account = makeExchangeAccount();
      await backend.addExchangeAccount(account);
      await syncCexAccount(backend, makeMockAdapter(records), account);

      const accounts = await backend.listExchangeAccounts();
      expect(accounts[0].last_sync).toBeTruthy();
    });
  });
});
