import type { Backend } from "$lib/backend.js";
import type { JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvRecord } from "./types.js";
import { crossSourceAliases, cexSourceFromCsvPreset } from "./cross-source.js";

export interface DedupIndex {
  sources: Set<string>;
  fingerprints: Set<string>;
  amountFingerprints: Set<string>;
}

/**
 * Compute a deterministic fingerprint from a CsvRecord.
 * Format: "date:lowercased_description:sorted currency:amount pairs"
 * Intentionally excludes account names so re-importing with a different
 * main account still detects duplicates.
 */
export function computeRecordFingerprint(rec: CsvRecord): string {
  const pairs = rec.lines
    .map((l) => `${l.currency}:${l.amount}`)
    .sort();
  return `${rec.date}:${rec.description.toLowerCase().trim()}:${pairs.join("|")}`;
}

/**
 * Compute the same fingerprint format from an existing DB entry + line items.
 */
export function computeEntryFingerprint(entry: JournalEntry, items: LineItem[]): string {
  const pairs = items
    .map((li) => `${li.currency}:${li.amount}`)
    .sort();
  return `${entry.date}:${entry.description.toLowerCase().trim()}:${pairs.join("|")}`;
}

/**
 * Compute an amount-only fingerprint from a CsvRecord.
 * Format: "date:sorted currency:amount pairs" (no description).
 * Used for cross-format dedup where date + amounts match but descriptions differ.
 */
export function computeAmountFingerprint(rec: CsvRecord): string {
  const pairs = rec.lines
    .map((l) => `${l.currency}:${l.amount}`)
    .sort();
  return `${rec.date}:${pairs.join("|")}`;
}

/**
 * Compute the same amount-only fingerprint from an existing DB entry + line items.
 */
export function computeEntryAmountFingerprint(entry: JournalEntry, items: LineItem[]): string {
  const pairs = items
    .map((li) => `${li.currency}:${li.amount}`)
    .sort();
  return `${entry.date}:${pairs.join("|")}`;
}

/**
 * Build a dedup index by querying existing entries whose dates overlap
 * the CSV records' date range. Skips voided entries.
 */
export async function buildDedupIndex(
  backend: Backend,
  records: CsvRecord[],
  presetId?: string,
): Promise<DedupIndex> {
  const sources = new Set<string>();
  const fingerprints = new Set<string>();
  const amountFingerprints = new Set<string>();

  if (records.length === 0) return { sources, fingerprints, amountFingerprints };

  // Find min/max date from records
  let minDate = records[0].date;
  let maxDate = records[0].date;
  for (const rec of records) {
    if (rec.date < minDate) minDate = rec.date;
    if (rec.date > maxDate) maxDate = rec.date;
  }

  // Query existing entries in the date range
  const entries = await backend.queryJournalEntries({
    from_date: minDate,
    to_date: maxDate,
  });

  for (const [entry, items] of entries) {
    // Skip voided entries
    if (entry.voided_by !== null) continue;

    // Add source for source-based matching (+ cross-source aliases)
    if (entry.source) {
      sources.add(entry.source);
      for (const alias of crossSourceAliases(entry.source)) {
        sources.add(alias);
      }
    }

    // Add fingerprint for fingerprint-based matching
    fingerprints.add(computeEntryFingerprint(entry, items));

    // Add amount fingerprint for cross-format matching
    amountFingerprints.add(computeEntryAmountFingerprint(entry, items));
  }

  return { sources, fingerprints, amountFingerprints };
}

/**
 * Check if a record is a duplicate based on source match (fast, exact)
 * or fingerprint match (universal).
 */
export function isDuplicate(
  rec: CsvRecord,
  presetId: string | undefined,
  index: DedupIndex,
): boolean {
  // Source-based check (fast, exact) — only when sourceKey is present
  if (rec.sourceKey && presetId) {
    const source = `csv-import:${presetId}:${rec.sourceKey}`;
    if (index.sources.has(source)) return true;
    // Cross-source: also check CEX format directly (belt-and-suspenders)
    const cexSource = cexSourceFromCsvPreset(presetId, rec.sourceKey);
    if (cexSource && index.sources.has(cexSource)) return true;
  }

  // Fingerprint-based check (universal)
  const fp = computeRecordFingerprint(rec);
  if (index.fingerprints.has(fp)) return true;

  // Amount-based check (cross-format — ignores description)
  const afp = computeAmountFingerprint(rec);
  return index.amountFingerprints.has(afp);
}
