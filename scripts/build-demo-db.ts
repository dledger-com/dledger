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

  // Synthesize lot + lot_disposal rows so the gain/loss report has data.
  // The browser SqlJsBackend never writes these tables (lot tracking is
  // implemented only in the Rust backend used by the Tauri build), so the
  // demo build needs explicit inserts. We use direct SQL via the private
  // db handle and reference the imported journal entries by description.
  console.log("[demo-db] synthesizing lot / lot_disposal rows");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerDb = (backend as any).db as import("sql.js").Database;

  function findEntryId(description: string): string {
    const result = innerDb.exec(
      "SELECT id FROM journal_entry WHERE description = ? LIMIT 1",
      [description],
    );
    if (result.length === 0 || result[0].values.length === 0) {
      throw new Error(`[demo-db] no journal_entry found for "${description}"`);
    }
    return result[0].values[0][0] as string;
  }

  function findAccountId(fullName: string): string {
    const result = innerDb.exec(
      "SELECT id FROM account WHERE full_name = ? LIMIT 1",
      [fullName],
    );
    if (result.length === 0 || result[0].values.length === 0) {
      throw new Error(`[demo-db] no account found for "${fullName}"`);
    }
    return result[0].values[0][0] as string;
  }

  const krakenId = findAccountId("Assets:Crypto:Exchange:Kraken");
  const coinbaseId = findAccountId("Assets:Crypto:Exchange:Coinbase");

  // Lots: each cost-basis buy in the seed file becomes one lot row.
  // remaining_quantity is the post-sell residual (for the open-lots view);
  // the gain_loss report itself only reads the disposal table.
  type LotSeed = {
    key: string;
    description: string;
    accountId: string;
    currency: string;
    acquiredDate: string;
    originalQty: string;
    remainingQty: string;
    unitCost: string;
  };
  const lotSeeds: LotSeed[] = [
    { key: "btc1", description: "Buy 0.10 BTC on Kraken", accountId: krakenId, currency: "BTC", acquiredDate: "2023-02-15", originalQty: "0.10000000", remainingQty: "0.04500000", unitCost: "22500" },
    { key: "eth1", description: "Buy 1.5 ETH on Kraken",  accountId: krakenId, currency: "ETH", acquiredDate: "2023-04-15", originalQty: "1.50000000", remainingQty: "0.95000000", unitCost: "1700" },
    { key: "btc2", description: "Buy 0.03 BTC on Kraken", accountId: krakenId, currency: "BTC", acquiredDate: "2023-07-25", originalQty: "0.03000000", remainingQty: "0.03000000", unitCost: "26800" },
    { key: "eth2", description: "Buy 0.5 ETH on Kraken",  accountId: krakenId, currency: "ETH", acquiredDate: "2023-09-05", originalQty: "0.50000000", remainingQty: "0.50000000", unitCost: "1450" },
    { key: "ethC", description: "Buy 0.15 ETH on Coinbase", accountId: coinbaseId, currency: "ETH", acquiredDate: "2024-05-12", originalQty: "0.15000000", remainingQty: "0.15000000", unitCost: "3000" },
    { key: "usdc", description: "Buy 1000 USDC on Kraken", accountId: krakenId, currency: "USDC", acquiredDate: "2024-10-08", originalQty: "1000.00000000", remainingQty: "1000.00000000", unitCost: "0.92" },
    { key: "sol",  description: "Buy 5 SOL on Kraken",     accountId: krakenId, currency: "SOL",  acquiredDate: "2025-09-10", originalQty: "5.00000000",   remainingQty: "5.00000000",   unitCost: "145" },
    { key: "eth3", description: "Buy 0.10 ETH on Kraken",  accountId: krakenId, currency: "ETH",  acquiredDate: "2026-03-12", originalQty: "0.10000000",  remainingQty: "0.10000000",  unitCost: "3250" },
  ];

  const lotIds = new Map<string, string>();
  for (const lot of lotSeeds) {
    const lotId = uuidv7();
    const journalId = findEntryId(lot.description);
    const isClosed = parseFloat(lot.remainingQty) === 0 ? 1 : 0;
    innerDb.run(
      `INSERT INTO lot (id, account_id, currency, acquired_date, original_quantity, remaining_quantity, cost_basis_per_unit, cost_basis_currency, journal_entry_id, is_closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lotId, lot.accountId, lot.currency, lot.acquiredDate, lot.originalQty, lot.remainingQty, lot.unitCost, "EUR", journalId, isClosed],
    );
    lotIds.set(lot.key, lotId);
  }

  // Disposals: each cost-basis sell in the seed file becomes one row.
  // FIFO from the oldest matching lot of the same currency on the same
  // account. Realized gain = (proceeds_per_unit - cost_per_unit) * qty.
  type DisposalSeed = {
    description: string;
    lotKey: string;
    qty: string;
    unitProceeds: string;
    realizedGain: string;
    date: string;
  };
  const disposalSeeds: DisposalSeed[] = [
    { description: "Sell 0.05 BTC on Kraken",  lotKey: "btc1", qty: "0.05000000", unitProceeds: "64500", realizedGain: "2100.00", date: "2024-11-20" },
    { description: "Sell 0.5 ETH on Kraken",   lotKey: "eth1", qty: "0.50000000", unitProceeds: "3100",  realizedGain: "700.00",  date: "2025-03-15" },
    { description: "Sell 0.005 BTC on Kraken", lotKey: "btc1", qty: "0.00500000", unitProceeds: "99000", realizedGain: "382.50",  date: "2026-02-23" },
    { description: "Sell 0.05 ETH on Kraken",  lotKey: "eth1", qty: "0.05000000", unitProceeds: "3290",  realizedGain: "79.50",   date: "2026-03-26" },
  ];

  for (const d of disposalSeeds) {
    const lotId = lotIds.get(d.lotKey);
    if (!lotId) throw new Error(`[demo-db] unknown lot key ${d.lotKey}`);
    const journalId = findEntryId(d.description);
    innerDb.run(
      `INSERT INTO lot_disposal (id, lot_id, journal_entry_id, quantity, proceeds_per_unit, proceeds_currency, realized_gain_loss, disposal_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv7(), lotId, journalId, d.qty, d.unitProceeds, "EUR", d.realizedGain, d.date],
    );
  }
  console.log(`[demo-db]   wrote ${lotSeeds.length} lots, ${disposalSeeds.length} disposals`);

  console.log("[demo-db] pre-baking French tax reports");
  const { computeFrenchTaxReport } = await import("../src/lib/utils/french-tax.js");
  // Same offset as the seed dates so the cached reports line up with the
  // (shifted) underlying data. Includes 2026 (the seed-author year) so
  // the small in-progress current-year dispositions get a cached report.
  const TAX_YEARS = [2023, 2024, 2025, 2026].map((y) => y + YEAR_OFFSET);
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
