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

// The seed file is authored as if "today" is this calendar year. The build
// script shifts every date in the seed by `currentYear - SEED_AUTHOR_YEAR`
// so the demo always shows "history through last full year + current year
// so far," regardless of when it's rebuilt. Bump this constant when you
// rewrite the seed file with new dates.
const SEED_AUTHOR_YEAR = 2026;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Shift every YYYY-MM-DD in the beancount text forward by `offset` years.
 * Year-only shift preserves tax-year boundaries (no transaction crosses
 * a year boundary as a side effect of shifting). Feb 29 is clamped to
 * Feb 28 in non-leap target years.
 */
function shiftDates(content: string, offset: number): string {
  if (offset === 0) return content;
  return content.replace(
    /\b(20\d{2})-(\d{2})-(\d{2})\b/g,
    (_match, y: string, mo: string, d: string) => {
      const newYear = parseInt(y, 10) + offset;
      let day = parseInt(d, 10);
      if (mo === "02" && day === 29 && !isLeapYear(newYear)) {
        day = 28; // clamp to Feb 28 when target year isn't a leap year
      }
      return `${newYear}-${mo}-${String(day).padStart(2, "0")}`;
    },
  );
}

async function main() {
  const TODAY_YEAR = new Date().getFullYear();
  const YEAR_OFFSET = TODAY_YEAR - SEED_AUTHOR_YEAR;

  console.log(`[demo-db] reading ${BEANCOUNT_PATH}`);
  const rawBeancount = readFileSync(BEANCOUNT_PATH, "utf-8");

  if (YEAR_OFFSET !== 0) {
    console.log(
      `[demo-db] shifting seed dates by ${YEAR_OFFSET >= 0 ? "+" : ""}${YEAR_OFFSET} years ` +
        `(seed author=${SEED_AUTHOR_YEAR}, today=${TODAY_YEAR})`,
    );
  } else {
    console.log(`[demo-db] no date shift (seed author=${SEED_AUTHOR_YEAR}, today=${TODAY_YEAR})`);
  }
  const beancount = shiftDates(rawBeancount, YEAR_OFFSET);

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

  // Pre-bake French tax reports for the years that have crypto activity in
  // the seed file. The demo runtime can't call saveFrenchTaxReport (the
  // ReadOnlyBackend rejects mutations), so we cache them here and the page
  // serves them via getFrenchTaxReport. Each year's prior acquisition cost
  // chains from the previous year's finalAcquisitionCost.
  // Seed a few monthly budgets so the Reports → Budgets page has actual
  // vs target bars. The seeding uses createBudget() (which the demo's
  // ReadOnlyBackend would block at runtime — but the script runs against
  // the raw SqlJsBackend, not the wrapper).
  console.log("[demo-db] seeding budgets");
  const { v7: uuidv7 } = await import("uuid");
  const nowIso = new Date().toISOString();
  const budgets = [
    { account_pattern: "Expenses:Food", amount: "550" },
    { account_pattern: "Expenses:Transport", amount: "180" },
    { account_pattern: "Expenses:Entertainment", amount: "120" },
    { account_pattern: "Expenses:Shopping", amount: "200" },
  ];
  for (const b of budgets) {
    await backend.createBudget({
      id: uuidv7(),
      account_pattern: b.account_pattern,
      period_type: "monthly",
      amount: b.amount,
      currency: "EUR",
      start_date: null,
      end_date: null,
      created_at: nowIso,
    });
  }
  console.log(`[demo-db]   seeded ${budgets.length} monthly budgets`);

  console.log("[demo-db] pre-baking French tax reports");
  const { computeFrenchTaxReport } = await import("../src/lib/utils/french-tax.js");
  // Same offset as the seed dates so the cached reports line up with the
  // (shifted) underlying data.
  const TAX_YEARS = [2023, 2024, 2025].map((y) => y + YEAR_OFFSET);
  let priorCost = "0";
  for (const year of TAX_YEARS) {
    const report = await computeFrenchTaxReport(backend, {
      taxYear: year,
      priorAcquisitionCost: priorCost,
      priorCostSource: priorCost === "0" ? "none" : "chained",
    });
    await backend.saveFrenchTaxReport(year, report, {});
    console.log(
      `[demo-db]   ${year}: ${report.dispositions.length} dispositions, ` +
        `total PV=${report.totalPlusValue} EUR, ` +
        `final A=${report.finalAcquisitionCost} EUR`,
    );
    priorCost = report.finalAcquisitionCost;
  }

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
