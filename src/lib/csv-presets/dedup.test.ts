import { describe, it, expect, beforeEach } from "vitest";
import {
  computeRecordFingerprint,
  computeEntryFingerprint,
  computeAmountFingerprint,
  computeEntryAmountFingerprint,
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
      amountFingerprints: new Set(),
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
      amountFingerprints: new Set(),
    };
    expect(isDuplicate(rec, undefined, index)).toBe(true);
  });

  it("returns false for non-duplicate", () => {
    const index: DedupIndex = {
      sources: new Set(),
      fingerprints: new Set(),
      amountFingerprints: new Set(),
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
      amountFingerprints: new Set(),
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

  it("detects amount-fingerprint duplicate (same date+amounts, different description)", () => {
    const csvRec: CsvRecord = {
      date: "2024-01-15",
      description: "CB CARREFOUR",
      lines: [
        { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
        { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
      ],
    };
    const index: DedupIndex = {
      sources: new Set(),
      fingerprints: new Set(),
      amountFingerprints: new Set([computeAmountFingerprint({
        date: "2024-01-15",
        description: "PAYMENT CARREFOUR STORE 123",
        lines: [
          { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
          { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
        ],
      })]),
    };
    expect(isDuplicate(csvRec, undefined, index)).toBe(true);
  });

  it("does not match amount fingerprint when amounts differ", () => {
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
      fingerprints: new Set(),
      amountFingerprints: new Set(["2024-01-15:EUR:10|EUR:-10"]),
    };
    expect(isDuplicate(rec, undefined, index)).toBe(false);
  });
});

describe("computeAmountFingerprint", () => {
  it("produces fingerprint without description", () => {
    const rec: CsvRecord = {
      date: "2024-01-15",
      description: "Coffee Shop",
      lines: [
        { account: "Expenses:Food", currency: "EUR", amount: "-5" },
        { account: "Assets:Bank", currency: "EUR", amount: "5" },
      ],
    };
    const afp = computeAmountFingerprint(rec);
    expect(afp).toBe("2024-01-15:EUR:-5|EUR:5");
    expect(afp).not.toContain("coffee");
  });

  it("sorts pairs for consistency", () => {
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
    expect(computeAmountFingerprint(rec1)).toBe(computeAmountFingerprint(rec2));
  });

  it("matches across different descriptions (cross-format)", () => {
    const csvRec: CsvRecord = {
      date: "2024-03-10",
      description: "CB CARREFOUR",
      lines: [
        { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
        { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
      ],
    };
    const ofxRec: CsvRecord = {
      date: "2024-03-10",
      description: "PAYMENT CARREFOUR STORE 123",
      lines: [
        { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
        { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
      ],
    };
    expect(computeAmountFingerprint(csvRec)).toBe(computeAmountFingerprint(ofxRec));
  });
});

describe("computeEntryAmountFingerprint", () => {
  it("matches record amount fingerprint for same data", () => {
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
      description: "Different description",
      status: "confirmed" as const,
      source: "csv-import",
      voided_by: null,
      created_at: "2024-01-15",
    };
    const items = [
      { id: "l1", journal_entry_id: "e1", account_id: "a1", currency: "EUR", amount: "-5", lot_id: null },
      { id: "l2", journal_entry_id: "e1", account_id: "a2", currency: "EUR", amount: "5", lot_id: null },
    ];
    expect(computeEntryAmountFingerprint(entry, items)).toBe(computeAmountFingerprint(rec));
  });
});

describe("buildDedupIndex amountFingerprints", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("populates amountFingerprints from existing entries", async () => {
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

    const index = await buildDedupIndex(backend, records);
    expect(index.amountFingerprints.size).toBeGreaterThan(0);
    expect(index.amountFingerprints.has(computeAmountFingerprint(records[0]))).toBe(true);
  });

  it("returns empty amountFingerprints for empty records", async () => {
    const index = await buildDedupIndex(backend, []);
    expect(index.amountFingerprints.size).toBe(0);
  });
});

describe("cross-format dedup scenario", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("detects OFX record as duplicate of CSV-imported entry with different description", async () => {
    // Import a CSV record
    const csvRecords: CsvRecord[] = [
      {
        date: "2024-03-10",
        description: "CB CARREFOUR",
        lines: [
          { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
          { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
        ],
        sourceKey: "csv-tx-001",
      },
    ];
    await importRecords(backend, csvRecords, "la-banque-postale");

    // Now try to import an OFX record with different description but same date+amounts
    const ofxRecords: CsvRecord[] = [
      {
        date: "2024-03-10",
        description: "PAYMENT CARREFOUR STORE 123",
        lines: [
          { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
          { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
        ],
        sourceKey: "ofx-fitid-001",
      },
    ];

    const index = await buildDedupIndex(backend, ofxRecords, "ofx-import");
    expect(isDuplicate(ofxRecords[0], "ofx-import", index)).toBe(true);
  });

  it("does not flag as duplicate when amounts differ", async () => {
    const csvRecords: CsvRecord[] = [
      {
        date: "2024-03-10",
        description: "CB CARREFOUR",
        lines: [
          { account: "Expenses:Groceries", currency: "EUR", amount: "42.50" },
          { account: "Assets:Bank", currency: "EUR", amount: "-42.50" },
        ],
      },
    ];
    await importRecords(backend, csvRecords);

    const ofxRecords: CsvRecord[] = [
      {
        date: "2024-03-10",
        description: "PAYMENT CARREFOUR STORE 123",
        lines: [
          { account: "Expenses:Groceries", currency: "EUR", amount: "99.99" },
          { account: "Assets:Bank", currency: "EUR", amount: "-99.99" },
        ],
      },
    ];

    const index = await buildDedupIndex(backend, ofxRecords);
    expect(isDuplicate(ofxRecords[0], undefined, index)).toBe(false);
  });
});
