// Build the demo SQLite snapshot from samples/demo.beancount.
//
// Run via `bun run build:demo-db`. Imports the beancount file through the
// real SqlJsBackend pipeline (so the schema and importer behavior match the
// runtime exactly), seeds a few extras the importer can't produce on its
// own (budgets, French tax cache), and writes static/demo.sqlite.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shim browser globals that some modules touch on import. Mirrors src/test/setup.ts.
const _store = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    _store.set(k, v);
  },
  removeItem: (k: string) => {
    _store.delete(k);
  },
  clear: () => _store.clear(),
  get length() {
    return _store.size;
  },
  key: (i: number) => [..._store.keys()][i] ?? null,
};

// Stub indexedDB so the deferred persistence callback in SqlJsBackend
// (scheduled via setTimeout after every mutation) can no-op instead of
// crashing when it fires after the script has already written its snapshot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).indexedDB = {
  open() {
    // Return a fake request whose handlers are never called.
    return { onsuccess: null, onerror: null, onupgradeneeded: null };
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BEANCOUNT_PATH = resolve(REPO_ROOT, "samples/demo.beancount");
const OUT_PATH = resolve(REPO_ROOT, "static/demo.sqlite");

async function main() {
  console.log(`[demo-db] reading ${BEANCOUNT_PATH}`);
  const beancount = readFileSync(BEANCOUNT_PATH, "utf-8");

  console.log("[demo-db] initializing in-memory backend");
  const { SqlJsBackend } = await import("../src/lib/sql-js-backend.js");
  const backend = await SqlJsBackend.createInMemory();

  console.log("[demo-db] importing ledger");
  const result = await backend.importLedgerFile(beancount, "beancount");
  console.log(
    `[demo-db]   imported ${result.transactions_imported} transactions, ` +
      `${result.accounts_created} accounts, ` +
      `${result.currencies_created} currencies, ` +
      `${result.prices_imported} prices`,
  );
  if (result.warnings.length > 0) {
    console.warn("[demo-db] warnings:");
    for (const w of result.warnings) console.warn("  ", w);
  }

  // TODO (Phase 2b): seed budgets, balance assertion results cache, French
  // tax report cache, and any other extras the importer can't produce.

  console.log("[demo-db] exporting snapshot");
  const snapshot = await backend.exportDatabase();

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, snapshot);
  console.log(`[demo-db] wrote ${snapshot.length} bytes → ${OUT_PATH}`);

  // Cancel any pending deferred-save timer and exit cleanly. Without this,
  // Bun keeps the event loop alive for ~500ms and the persistence callback
  // would try to touch indexedDB (now a no-op stub).
  backend.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("[demo-db] failed:", e);
  process.exit(1);
});
