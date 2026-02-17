/**
 * Static registry of bundled plugins available in the browser.
 * Plugin WASM is transpiled at build time by scripts/transpile-plugins.mjs
 * and output to src/lib/wasm/plugins/<id>/.
 */

import type { CapabilitiesDecl } from "./host/capabilities.js";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: "source" | "handler";
  capabilities: CapabilitiesDecl;
}

/** All handler plugins bundled for browser use. */
export const HANDLER_PLUGINS: PluginManifest[] = [
  {
    id: "cost-basis",
    name: "Cost Basis Calculator",
    version: "0.1.0",
    description: "Compute FIFO cost basis and realized gains/losses for crypto assets",
    author: "dledger",
    kind: "handler",
    capabilities: { ledger_read: true },
  },
  {
    id: "missing-info",
    name: "Missing Info Detector",
    version: "0.1.0",
    description: "Scan ledger for transactions with missing or ambiguous data",
    author: "dledger",
    kind: "handler",
    capabilities: { ledger_read: true },
  },
  {
    id: "tax-report-fr",
    name: "French Tax Report",
    version: "0.1.0",
    description: "Generate Formulaire 2086 and 3916-bis for French tax filing",
    author: "dledger",
    kind: "handler",
    capabilities: { ledger_read: true },
  },
  {
    id: "export-beancount",
    name: "Beancount Export",
    version: "0.1.0",
    description: "Export ledger to Beancount format",
    author: "dledger",
    kind: "handler",
    capabilities: { ledger_read: true },
  },
  {
    id: "export-hledger",
    name: "hledger Export",
    version: "0.1.0",
    description: "Export ledger to hledger/ledger journal format",
    author: "dledger",
    kind: "handler",
    capabilities: { ledger_read: true },
  },
];

/** Source plugins bundled for browser use. */
export const SOURCE_PLUGINS: PluginManifest[] = [
  {
    id: "csv-import",
    name: "CSV Import",
    version: "0.1.0",
    description: "Import transactions from CSV files with configurable column mapping",
    author: "dledger",
    kind: "source",
    capabilities: { ledger_read: false, ledger_write: true },
  },
  {
    id: "kraken",
    name: "Kraken Exchange",
    version: "0.1.0",
    description: "Import trades from Kraken exchange via API",
    author: "dledger",
    kind: "source",
    capabilities: {
      ledger_read: true,
      ledger_write: true,
      http: true,
      network: { allowed_domains: ["api.kraken.com"], rate_limit: 15 },
    },
  },
  {
    id: "etherscan",
    name: "Etherscan",
    version: "0.1.0",
    description: "Track ETH transactions via Etherscan API",
    author: "dledger",
    kind: "source",
    capabilities: {
      ledger_read: true,
      ledger_write: true,
      http: true,
      network: { allowed_domains: ["api.etherscan.io"], rate_limit: 5 },
    },
  },
  {
    id: "mempool",
    name: "mempool.space BTC",
    version: "0.1.0",
    description: "Track Bitcoin transactions via mempool.space API",
    author: "dledger",
    kind: "source",
    capabilities: {
      ledger_read: true,
      ledger_write: true,
      http: true,
      network: { allowed_domains: ["mempool.space"], rate_limit: 10 },
    },
  },
];

/** All bundled plugins. */
export const ALL_PLUGINS: PluginManifest[] = [...HANDLER_PLUGINS, ...SOURCE_PLUGINS];
