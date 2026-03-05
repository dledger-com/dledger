import { describe, it, expect, beforeEach } from "vitest";
import { crossSourceAliases, cexSourceFromCsvPreset } from "./cross-source.js";
import { buildDedupIndex, isDuplicate } from "./dedup.js";
import type { DedupIndex } from "./dedup.js";
import { importRecords } from "./transform.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { CsvRecord } from "./types.js";

describe("crossSourceAliases", () => {
  it("maps CSV kraken source to CEX format", () => {
    expect(crossSourceAliases("csv-import:kraken-ledger:D2FK3E")).toEqual([
      "kraken:D2FK3E",
    ]);
  });

  it("maps CEX kraken source to CSV format", () => {
    expect(crossSourceAliases("kraken:D2FK3E")).toEqual([
      "csv-import:kraken-ledger:D2FK3E",
    ]);
  });

  it("maps CSV volet source to CEX format", () => {
    expect(crossSourceAliases("csv-import:volet:TX123")).toEqual([
      "volet:TX123",
    ]);
  });

  it("maps CEX volet source to CSV format", () => {
    expect(crossSourceAliases("volet:TX123")).toEqual([
      "csv-import:volet:TX123",
    ]);
  });

  it("returns empty for unmapped CSV preset", () => {
    expect(crossSourceAliases("csv-import:binance-trade:abc")).toEqual([]);
  });

  it("returns empty for unmapped CEX exchange", () => {
    expect(crossSourceAliases("binance:abc")).toEqual([]);
  });

  it("returns empty for csv-import without sourceKey", () => {
    expect(crossSourceAliases("csv-import:kraken-ledger")).toEqual([]);
  });

  it("returns empty for non-prefixed source without colon", () => {
    expect(crossSourceAliases("manual")).toEqual([]);
  });

  it("returns empty for etherscan sources", () => {
    expect(crossSourceAliases("etherscan:1:0xabc")).toEqual([]);
  });

  it("handles sourceKey containing colons", () => {
    // CEX refids shouldn't have colons, but ensure robustness
    expect(crossSourceAliases("csv-import:kraken-ledger:A:B")).toEqual([
      "kraken:A:B",
    ]);
  });
});

describe("cexSourceFromCsvPreset", () => {
  it("returns CEX source for mapped preset", () => {
    expect(cexSourceFromCsvPreset("kraken-ledger", "D2FK3E")).toBe(
      "kraken:D2FK3E",
    );
  });

  it("returns CEX source for volet preset", () => {
    expect(cexSourceFromCsvPreset("volet", "TX123")).toBe("volet:TX123");
  });

  it("returns null for unmapped preset", () => {
    expect(cexSourceFromCsvPreset("binance-trade", "abc")).toBeNull();
  });

  it("returns null for unknown preset", () => {
    expect(cexSourceFromCsvPreset("unknown", "abc")).toBeNull();
  });
});

describe("cross-source dedup integration", () => {
  it("isDuplicate catches CEX-sourced entry when importing CSV", () => {
    // Simulate: DB has an entry from CEX sync with source "kraken:D2FK3E"
    const index: DedupIndex = {
      sources: new Set(["kraken:D2FK3E"]),
      fingerprints: new Set(),
      amountFingerprints: new Set(),
    };

    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Kraken trade",
      lines: [
        { account: "Assets:Crypto:Exchange:Kraken:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:Crypto:Exchange:Kraken:USD", currency: "USD", amount: "-50000" },
      ],
      sourceKey: "D2FK3E",
    };

    // isDuplicate should find it via cross-source check
    expect(isDuplicate(rec, "kraken-ledger", index)).toBe(true);
  });

  it("isDuplicate does not false-positive for unrelated presets", () => {
    const index: DedupIndex = {
      sources: new Set(["kraken:D2FK3E"]),
      fingerprints: new Set(),
      amountFingerprints: new Set(),
    };

    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Some trade",
      lines: [
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
      ],
      sourceKey: "D2FK3E",
    };

    // binance-trade has no mapping, should not match
    expect(isDuplicate(rec, "binance-trade", index)).toBe(false);
  });

  it("buildDedupIndex includes cross-source aliases for CEX entries", async () => {
    const backend = await createTestBackend();

    // Simulate a CEX-synced entry by importing with source "kraken:REFID1"
    // We do this by directly posting a journal entry
    const { v7: uuidv7 } = await import("uuid");
    await backend.createCurrency({
      code: "BTC",
      asset_type: "",
      param: "",
      name: "Bitcoin",
      decimal_places: 8,
      is_base: false,
    });
    await backend.createCurrency({
      code: "USD",
      asset_type: "",
      param: "",
      name: "US Dollar",
      decimal_places: 2,
      is_base: false,
    });
    await backend.createAccount({
      id: uuidv7(),
      parent_id: null,
      account_type: "asset",
      name: "Assets",
      full_name: "Assets",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-15",
    });
    const btcAccId = uuidv7();
    await backend.createAccount({
      id: btcAccId,
      parent_id: null,
      account_type: "asset",
      name: "BTC",
      full_name: "Assets:BTC",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-15",
    });
    const usdAccId = uuidv7();
    await backend.createAccount({
      id: usdAccId,
      parent_id: null,
      account_type: "asset",
      name: "USD",
      full_name: "Assets:USD",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-15",
    });

    // Create equity account for trading counterpart
    const eqAccId = uuidv7();
    await backend.createAccount({
      id: eqAccId,
      parent_id: null,
      account_type: "equity",
      name: "Trading",
      full_name: "Equity:Trading",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-15",
    });

    const entryId = uuidv7();
    await backend.postJournalEntry(
      {
        id: entryId,
        date: "2024-01-15",
        description: "Kraken trade",
        status: "confirmed",
        source: "kraken:REFID1",
        voided_by: null,
        created_at: "2024-01-15",
      },
      [
        { id: uuidv7(), journal_entry_id: entryId, account_id: btcAccId, currency: "BTC", amount: "1", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: eqAccId, currency: "BTC", amount: "-1", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: usdAccId, currency: "USD", amount: "-50000", lot_id: null },
        { id: uuidv7(), journal_entry_id: entryId, account_id: eqAccId, currency: "USD", amount: "50000", lot_id: null },
      ],
    );

    // Build dedup index — should contain the CEX source AND the CSV alias
    const records: CsvRecord[] = [
      {
        date: "2024-01-15",
        description: "Kraken trade",
        lines: [
          { account: "Assets:BTC", currency: "BTC", amount: "1" },
          { account: "Assets:USD", currency: "USD", amount: "-50000" },
        ],
        sourceKey: "REFID1",
      },
    ];

    const index = await buildDedupIndex(backend, records, "kraken-ledger");
    expect(index.sources.has("kraken:REFID1")).toBe(true);
    expect(index.sources.has("csv-import:kraken-ledger:REFID1")).toBe(true);
  });

  it("buildDedupIndex includes cross-source aliases for CSV entries", async () => {
    const backend = await createTestBackend();

    // Import via CSV preset
    const records: CsvRecord[] = [
      {
        date: "2024-01-15",
        description: "Kraken trade",
        lines: [
          { account: "Expenses:Fees", currency: "USD", amount: "5" },
          { account: "Assets:Bank", currency: "USD", amount: "-5" },
        ],
        sourceKey: "REFID2",
      },
    ];
    await importRecords(backend, records, "kraken-ledger");

    // Build dedup index — should contain both CSV source AND CEX alias
    const index = await buildDedupIndex(backend, records, "kraken-ledger");
    expect(index.sources.has("csv-import:kraken-ledger:REFID2")).toBe(true);
    expect(index.sources.has("kraken:REFID2")).toBe(true);
  });
});
