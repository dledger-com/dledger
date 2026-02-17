#!/usr/bin/env node
/**
 * Transpile WASM plugin components to ESM using jco.
 *
 * Usage: node scripts/transpile-plugins.mjs
 *
 * Reads .wasm files from src-tauri/tests/fixtures/plugins/<id>/plugin.wasm
 * (or a directory specified by PLUGINS_SRC_DIR env var) and outputs
 * jco-transpiled ESM to src/lib/wasm/plugins/<id>/.
 *
 * All plugins are fully synchronous (no JSPI). HTTP plugins use
 * synchronous XMLHttpRequest in the host implementation.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_SRC =
  process.env.PLUGINS_SRC_DIR ||
  join(ROOT, "src-tauri/tests/fixtures/plugins");
const PLUGINS_OUT = join(ROOT, "src/lib/wasm/plugins");

const ALL_PLUGINS = [
  // Handler plugins
  "cost-basis",
  "missing-info",
  "tax-report-fr",
  "export-beancount",
  "export-hledger",
  // Source plugins
  "csv-import",
  "kraken",
  "etherscan",
  "mempool",
];

function transpilePlugin(id) {
  const wasmPath = join(PLUGINS_SRC, id, "plugin.wasm");
  if (!existsSync(wasmPath)) {
    console.warn(`  [SKIP] ${id}: ${wasmPath} not found`);
    return false;
  }

  const outDir = join(PLUGINS_OUT, id);
  mkdirSync(outDir, { recursive: true });

  // --instantiation async: makes instantiate() return a Promise (for module loading)
  // No --async-mode jspi: all host imports and exports are synchronous
  const cmd = `bunx jco transpile "${wasmPath}" --instantiation async -o "${outDir}"`;

  console.log(`  [JCO] ${id}`);
  try {
    execSync(cmd, { stdio: "pipe", cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`  [FAIL] ${id}: ${err.stderr?.toString() || err.message}`);
    return false;
  }
}

console.log("Transpiling plugins...");
console.log(`  Source: ${PLUGINS_SRC}`);
console.log(`  Output: ${PLUGINS_OUT}`);
console.log();

let success = 0;
let failed = 0;

for (const id of ALL_PLUGINS) {
  if (transpilePlugin(id)) {
    success++;
  } else {
    failed++;
  }
}

console.log();
console.log(`Done: ${success} transpiled, ${failed} skipped/failed`);
if (failed > 0) process.exit(1);
