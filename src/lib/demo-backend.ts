// Demo backend: loads a pre-baked SQLite snapshot from /demo.sqlite and wraps
// the resulting SqlJsBackend in a read-only Proxy. Any mutation method (post,
// create, update, delete, sync, import, etc.) throws DemoReadOnlyError.
//
// The wrapper is the safety net — the UI layer also gates mutation triggers
// behind {#if !DEMO_MODE} so the user never sees the buttons in the first
// place. If a mutation does slip through, this layer catches it.

import type { Backend } from "./backend.js";

export class DemoReadOnlyError extends Error {
  constructor(method: string) {
    super(`Demo mode: "${method}" is not available in the read-only demo.`);
    this.name = "DemoReadOnlyError";
  }
}

/**
 * Whitelist of Backend methods that are safe to call in demo mode.
 * Anything not in this set is treated as a mutation and throws.
 *
 * Keep this list in sync with the Backend interface in backend.ts.
 * Adding a new read method? Add it here.
 * Adding a new mutation? Do nothing — it's blocked by default.
 */
const READ_METHODS: ReadonlySet<string> = new Set([
  // Currencies
  "listCurrencies",
  "listHiddenCurrencies",
  "listCryptoAssetInfo",
  "getCurrencyOrigins",
  "getCurrencyTokenAddress",
  "getCurrencyTokenAddresses",
  "getCurrencyRateOverrides",
  "getRateFetchFailures",
  // Accounts
  "listAccounts",
  "getAccount",
  "getAccountBalance",
  "getAccountBalanceWithChildren",
  "getAccountMetadata",
  // Journal
  "getJournalEntry",
  "queryJournalEntries",
  "countJournalEntries",
  "queryEntriesByMetadata",
  "getMetadata",
  "getAllMetadataKeys",
  "getAllTagValues",
  "getEntryLinks",
  "getAllLinkNames",
  "getAllLinksWithCounts",
  "getEntriesByLink",
  // Reports
  "trialBalance",
  "incomeStatement",
  "balanceSheet",
  "balanceSheetBatch",
  "gainLossReport",
  "listOpenLots",
  // Budgets
  "listBudgets",
  // Exchange rates
  "getExchangeRate",
  "listExchangeRates",
  // Reconciliation / assertions
  "listBalanceAssertions",
  "checkBalanceAssertions",
  "listReconciliations",
  "getReconciliationDetail",
  "getUnreconciledLineItems",
  // French tax
  "listFrenchTaxReportYears",
  "getFrenchTaxReport",
  // Plugins
  "listCustomPlugins",
  // Etherscan + every blockchain account list
  "listEtherscanAccounts",
  "listExchangeAccounts",
  "listBitcoinAccounts",
  "getBtcTrackedAddresses",
  "listSolanaAccounts",
  "listHyperliquidAccounts",
  "listSuiAccounts",
  "listAptosAccounts",
  "listTonAccounts",
  "listTezosAccounts",
  "listCosmosAccounts",
  "listPolkadotAccounts",
  "listDogeAccounts",
  "listLtcAccounts",
  "listBchAccounts",
  "listDashAccounts",
  "listBsvAccounts",
  "listXecAccounts",
  "listGrsAccounts",
  "listXrpAccounts",
  "listTronAccounts",
  "listStellarAccounts",
  "listBittensorAccounts",
  "listHederaAccounts",
  "listNearAccounts",
  "listAlgorandAccounts",
  "listKaspaAccounts",
  "listZcashAccounts",
  "listStacksAccounts",
  "listCardanoAccounts",
  "listMoneroAccounts",
  "listBitsharesAccounts",
  // Raw transaction store (read-only queries)
  "getRawTransaction",
  "queryRawTransactions",
  "countDuplicateSources",
  "countOrphanedLineItems",
  // Export (file download — fine in demo, gives the user a snapshot to play with locally)
  "exportLedgerFile",
  "exportDatabase",
  // Lifecycle
  "close",
]);

export function wrapReadOnly(backend: Backend): Backend {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      if (typeof value !== "function") return value;
      if (READ_METHODS.has(prop)) {
        return value.bind(target);
      }
      // Anything else is treated as a mutation. Return a thunk that throws
      // when called rather than throwing on access (so feature-detection like
      // `if (backend.exportDatabase)` still works for actual reads).
      return (..._args: unknown[]) => {
        throw new DemoReadOnlyError(prop);
      };
    },
  }) as Backend;
}

export async function createDemoBackend(): Promise<Backend> {
  const response = await fetch("/demo.sqlite");
  if (!response.ok) {
    throw new Error(
      `Demo mode: failed to load /demo.sqlite (HTTP ${response.status}). ` +
        `Did you run \`bun run build:demo-db\`?`,
    );
  }
  const snapshot = new Uint8Array(await response.arrayBuffer());
  const { SqlJsBackend } = await import("./sql-js-backend.js");
  const inner = await SqlJsBackend.fromSnapshot(snapshot);
  return wrapReadOnly(inner);
}
