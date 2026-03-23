/**
 * Cross-source alias mapping for CSV ↔ CEX API dedup.
 *
 * When a user imports transactions from a CSV export AND syncs via the CEX API
 * for the same exchange, the source strings differ:
 *   CSV:  csv-import:{presetId}:{sourceKey}
 *   CEX:  {exchangeId}:{refid}
 *
 * This module bridges the two formats so source-based dedup works across them.
 */

/** Maps CSV preset IDs to CEX exchange IDs where raw IDs match between formats. */
const PRESET_TO_EXCHANGE: Record<string, string> = {
  "kraken-ledger": "kraken",
  "volet": "volet",
  "hyperliquid": "hyperliquid",
};

/** Reverse lookup: CEX exchange ID → CSV preset ID. */
const EXCHANGE_TO_PRESET: Record<string, string> = Object.fromEntries(
  Object.entries(PRESET_TO_EXCHANGE).map(([k, v]) => [v, k]),
);

/**
 * Given a source string, return aliases in other formats.
 *
 * - `"csv-import:kraken-ledger:D2FK3E"` → `["kraken:D2FK3E"]`
 * - `"kraken:D2FK3E"` → `["csv-import:kraken-ledger:D2FK3E"]`
 * - `"manual"` or unmapped sources → `[]`
 */
export function crossSourceAliases(source: string): string[] {
  // Try CSV → CEX direction: csv-import:{presetId}:{sourceKey}
  if (source.startsWith("csv-import:")) {
    const rest = source.slice("csv-import:".length);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) return []; // No sourceKey in source string
    const presetId = rest.slice(0, colonIdx);
    const sourceKey = rest.slice(colonIdx + 1);
    if (!sourceKey) return [];
    const exchangeId = PRESET_TO_EXCHANGE[presetId];
    if (!exchangeId) return [];
    return [`${exchangeId}:${sourceKey}`];
  }

  // Try CEX → CSV direction: {exchangeId}:{refid}
  const colonIdx = source.indexOf(":");
  if (colonIdx === -1) return [];
  const exchangeId = source.slice(0, colonIdx);
  const refid = source.slice(colonIdx + 1);
  if (!refid) return [];
  const presetId = EXCHANGE_TO_PRESET[exchangeId];
  if (!presetId) return [];
  return [`csv-import:${presetId}:${refid}`];
}

/**
 * Given a CSV preset ID and raw sourceKey, return the corresponding CEX source
 * string if a mapping exists.
 */
export function cexSourceFromCsvPreset(presetId: string, sourceKey: string): string | null {
  const exchangeId = PRESET_TO_EXCHANGE[presetId];
  if (!exchangeId) return null;
  return `${exchangeId}:${sourceKey}`;
}
