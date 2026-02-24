import { describe, it, expect, beforeEach } from "vitest";
import {
  computeRecordFingerprint,
  computeEntryFingerprint,
  buildDedupIndex,
  isDuplicate,
} from "./dedup.js";
import type { DedupIndex } from "./dedup.js";
import { importRecords } from "./transform.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import type { CsvRecord } from "./types.js";

describe("computeRecordFingerprint", () => {
  it("produces deterministic fingerprint from record", () => {
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee Shop",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "-5" },
        { account: "Assets:Bank", currency: "EUR", amount: "5" },
      ],
    };
    const fp = computeRecordFingerprint(rec);
    expect(fp).toBe("2024-01-15:coffee shop:EUR:-5|EUR:5");
  });

  it("sorts currency:amount pairs for consistency", () => {
    const rec1: CsvRecord = {
      date: "2024-01-15",
      description: "Trade",
      lines: [
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
      ],
    };
    const rec2: CsvRecord = {
      date: "2024-01-15",
      description: "Trade",
      lines: [
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
      ],
    };
    expect(computeRecordFingerprint(rec1)).toBe(computeRecordFingerprint(rec2));
  });

  it("lowercases description", () => {
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "COFFEE SHOP",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "-5" },
        { account: "Assets:Bank", currency: "EUR", amount: "5" },
      ],
    };
    expect(computeRecordFingerprint(rec)).toContain("coffee shop");
  });

  it("excludes account names from fingerprint", () => {
    const rec1: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee",
      lines: [
        { account: "Assets:Bank:Checking", currency: "EUR", amount: "5" },
        { account: "Expenses:Food", currency: "EUR", amount: "-5" },
      ],
    };
    const rec2: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee",
      lines: [
        { account: "Assets:Bank:Savings", currency: "EUR", amount: "5" },
        { account: "Expenses:Dining", currency: "EUR", amount: "-5" },
      ],
    };
    expect(computeRecordFingerprint(rec1)).toBe(computeRecordFingerprint(rec2));
  });
});

describe("computeEntryFingerprint", () => {
  it("matches record fingerprint for same data", () => {
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "-5" },
        { account: "Assets:Bank", currency: "EUR", amount: "5" },
      ],
    };
    const entry = {
      id: "e1",
      date: "2024-01-15",
      description: "Coffee",
      status: "confirmed" as const,
      source: "csv-import",
      voided_by: null,
      created_at: "2024-01-15",
    };
    const items = [
      { id: "l1", journal_entry_id: "e1", account_id: "a1", currency: "EUR", amount: "-5", lot_id: null },
      { id: "l2", journal_entry_id: "e1", account_id: "a2", currency: "EUR", amount: "5", lot_id: null },
    ];
    expect(computeEntryFingerprint(entry, items)).toBe(computeRecordFingerprint(rec));
  });
});

describe("buildDedupIndex", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("returns empty index for empty records", async () => {
    const index = await buildDedupIndex(backend, []);
    expect(index.sources.size).toBe(0);
    expect(index.fingerprints.size).toBe(0);
  });

  it("indexes existing entries in date range", async () => {
    // Import some records first
    const records: CsvRecord[] = [
      {
        date: "2024-01-15",
        description: "Coffee",
        lines: [
          { account: "Expenses:Food", currency: "USD", amount: "5" },
          { account: "Assets:Bank", currency: "USD", amount: "-5" },
        ],
        sourceKey: "tx-001",
      },
    ];
    await importRecords(backend, records, "test-preset");

    // Build index for same date range
    const index = await buildDedupIndex(backend, records, "test-preset");
    expect(index.sources.has("csv-import:test-preset:tx-001")).toBe(true);
    expect(index.fingerprints.size).toBeGreaterThan(0);
  });

  it("skips voided entries", async () => {
    const records: CsvRecord[] = [
      {
        date: "2024-01-15",
        description: "Coffee",
        lines: [
          { account: "Expenses:Food", currency: "USD", amount: "5" },
          { account: "Assets:Bank", currency: "USD", amount: "-5" },
        ],
      },
    ];
    await importRecords(backend, records);

    // Void the entry
    const entries = await backend.queryJournalEntries({});
    await backend.voidJournalEntry(entries[0][0].id);

    // Build index — voided entry should be excluded
    const index = await buildDedupIndex(backend, records);
    expect(index.fingerprints.size).toBe(0);
  });
});

describe("isDuplicate", () => {
  it("detects source-based duplicate", () => {
    const index: DedupIndex = {
      sources: new Set(["csv-import:kraken:tx-001"]),
      fingerprints: new Set(),
    };
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Trade",
      lines: [
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
      ],
      sourceKey: "tx-001",
    };
    expect(isDuplicate(rec, "kraken", index)).toBe(true);
  });

  it("detects fingerprint-based duplicate", () => {
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "5" },
        { account: "Assets:Bank", currency: "EUR", amount: "-5" },
      ],
    };
    const index: DedupIndex = {
      sources: new Set(),
      fingerprints: new Set([computeRecordFingerprint(rec)]),
    };
    expect(isDuplicate(rec, undefined, index)).toBe(true);
  });

  it("returns false for non-duplicate", () => {
    const index: DedupIndex = {
      sources: new Set(),
      fingerprints: new Set(),
    };
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "5" },
        { account: "Assets:Bank", currency: "EUR", amount: "-5" },
      ],
    };
    expect(isDuplicate(rec, undefined, index)).toBe(false);
  });

  it("source check requires both sourceKey and presetId", () => {
    const index: DedupIndex = {
      sources: new Set(["csv-import:kraken:tx-001"]),
      fingerprints: new Set(),
    };
    // No sourceKey on record
    const rec1: CsvRecord = {
      date: "2024-01-15",
      description: "Trade",
      lines: [
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
      ],
    };
    expect(isDuplicate(rec1, "kraken", index)).toBe(false);

    // No presetId
    const rec2: CsvRecord = {
      date: "2024-01-15",
      description: "Trade",
      lines: [
        { account: "Assets:BTC", currency: "BTC", amount: "1" },
        { account: "Assets:USD", currency: "USD", amount: "-50000" },
      ],
      sourceKey: "tx-001",
    };
    expect(isDuplicate(rec2, undefined, index)).toBe(false);
  });
});
