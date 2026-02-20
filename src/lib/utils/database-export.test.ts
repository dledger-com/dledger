import { describe, it, expect } from "vitest";
import { createTestBackend, seedBasicLedger } from "../../test/helpers.js";
import { SqlJsBackend } from "$lib/sql-js-backend.js";

describe("database export/import", () => {
  it("roundtrip: export from seeded backend, import to fresh, verify data", async () => {
    const { backend } = await seedBasicLedger();

    // Export
    const data = await backend.exportDatabase();
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBeGreaterThan(0);

    // Import into fresh backend
    const fresh = await createTestBackend();
    await fresh.importDatabase(data);

    // Verify data preserved
    const currencies = await fresh.listCurrencies();
    expect(currencies.length).toBe(2);
    expect(currencies.map((c) => c.code).sort()).toEqual(["EUR", "USD"]);

    const accounts = await fresh.listAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    const bankAccount = accounts.find((a) => a.full_name === "Assets:Bank");
    expect(bankAccount).toBeDefined();

    const entries = await fresh.queryJournalEntries({});
    expect(entries.length).toBe(3);
  });

  it("rejects invalid data", async () => {
    const backend = await createTestBackend();
    const invalidData = new Uint8Array([1, 2, 3, 4]);
    await expect(backend.importDatabase(invalidData)).rejects.toThrow();
  });

  it("export returns valid SQLite data", async () => {
    const backend = await createTestBackend();
    const data = await backend.exportDatabase();
    // SQLite magic bytes
    const header = new TextDecoder().decode(data.slice(0, 15));
    expect(header).toBe("SQLite format 3");
  });
});
