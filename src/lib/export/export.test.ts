import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { exportData } from "./export.js";
import { importData } from "./import.js";
import { defaultExportSelection, defaultImportSelection } from "./types.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

async function seedReferences(backend: SqlJsBackend) {
  await backend.upsertMlReferenceExamples([
    {
      id: uuidv7(),
      description: "SUPER U",
      account_path: "Expenses:Groceries",
      tags: ["groceries"],
      source: "imported",
      created_at: "2024-06-15T00:00:00Z",
    },
    {
      id: uuidv7(),
      description: "NETFLIX",
      account_path: "Expenses:Streaming",
      tags: ["streaming"],
      source: "user",
      created_at: "2024-06-15T00:00:00Z",
    },
  ]);
}

describe("export/import with ExportSelection", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* no localStorage in this env */ }
    // __APP_VERSION__ is injected by Vite at build time — provide a shim for tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__APP_VERSION__ = "test";
  });

  it("ML-only export contains ml-reference.json, no journal.json", async () => {
    const backend = await createTestBackend();
    await seedReferences(backend);

    const selection = defaultExportSelection();
    // Turn off all non-ML categories.
    selection.accounts = false;
    selection.journal = false;
    selection.currencies = false;
    selection.exchangeRates = false;
    selection.budgets = false;
    selection.reconciliations = false;
    selection.sources = false;
    selection.rawTransactions = false;
    selection.plugins = false;
    selection.settings = false;

    const data = await exportData(backend, { selection });

    // Peek inside: decode the header, unzip, and check artifacts.
    const { deserializeExport } = await import("./format.js");
    const { unzipSync, strFromU8 } = await import("fflate");
    const { payload } = deserializeExport(data);
    const files = unzipSync(payload);

    expect(files["manifest.json"]).toBeDefined();
    expect(files["ml-reference.json"]).toBeDefined();
    expect(files["journal.json"]).toBeUndefined();
    expect(files["accounts.json"]).toBeUndefined();
    expect(files["currencies.json"]).toBeUndefined();

    // The ML payload should carry both stored refs.
    const mlPayload = JSON.parse(strFromU8(files["ml-reference.json"]));
    expect(mlPayload.storedReferences).toHaveLength(2);
  });

  it("round-trips reference rows into a clean backend", async () => {
    const source = await createTestBackend();
    await seedReferences(source);

    const selection = defaultExportSelection();
    selection.accounts = false;
    selection.journal = false;
    selection.currencies = false;
    selection.exchangeRates = false;
    selection.budgets = false;
    selection.reconciliations = false;
    selection.sources = false;
    selection.rawTransactions = false;
    selection.plugins = false;
    selection.settings = false;

    const data = await exportData(source, { selection });

    const target = await createTestBackend();
    const importSelection = defaultImportSelection();
    const result = await importData(target, data, { mode: "merge-skip", selection: importSelection });

    expect(result.ml_references_imported).toBeGreaterThan(0);
    const refs = await target.listMlReferenceExamples();
    const descs = refs.map((r) => r.description);
    expect(descs).toContain("SUPER U");
    expect(descs).toContain("NETFLIX");

    // And no journal entries leaked across.
    const entries = await target.queryJournalEntries({});
    expect(entries).toHaveLength(0);
  });

  it("replace mode clears reference rows before importing", async () => {
    const source = await createTestBackend();
    await seedReferences(source);

    const selection = defaultExportSelection();
    const data = await exportData(source, { selection });

    const target = await createTestBackend();
    await target.upsertMlReferenceExamples([
      {
        id: uuidv7(),
        description: "STALE",
        account_path: "Expenses:Old",
        tags: null,
        source: "user",
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    await importData(target, data, { mode: "replace", selection: defaultImportSelection() });

    const refs = await target.listMlReferenceExamples();
    const descs = refs.map((r) => r.description);
    expect(descs).not.toContain("STALE"); // wiped by clearAllData
    expect(descs).toContain("SUPER U");
  });
});
