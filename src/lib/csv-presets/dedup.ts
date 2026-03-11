import type { Backend } from "$lib/backend.js";
import type { JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvRecord } from "./types.js";
import { crossSourceAliases, cexSourceFromCsvPreset } from "./cross-source.js";

export interface DedupIndex {
  sources: Set<string>;                    // source keys are unique — Set is fine
  fingerprints: Map<string, number>;       // count of DB entries per fingerprint
  amountFingerprints: Map<string, number>; // count of DB entries per amount fingerprint
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
  const fingerprints = new Map<string, number>();
  const amountFingerprints = new Map<string, number>();

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

    // Increment fingerprint count for fingerprint-based matching
    const fp = computeEntryFingerprint(entry, items);
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);

    // Increment amount fingerprint count for cross-format matching
    const afp = computeEntryAmountFingerprint(entry, items);
    amountFingerprints.set(afp, (amountFingerprints.get(afp) ?? 0) + 1);
  }

  return { sources, fingerprints, amountFingerprints };
}

/**
 * Check if a single record is a duplicate based on source match or fingerprint
 * match. Source matches don't consume fingerprint slots (orthogonal).
 * A full fingerprint match also consumes one amount fingerprint slot since a
 * single DB entry produces both fingerprints.
 */
function checkDuplicate(
  rec: CsvRecord,
  presetId: string | undefined,
  index: DedupIndex,
  fpConsumed: Map<string, number>,
  afpConsumed: Map<string, number>,
): boolean {
  // Source-based check (fast, exact) — doesn't consume fingerprint slots
  if (rec.sourceKey && presetId) {
    const source = `csv-import:${presetId}:${rec.sourceKey}`;
    if (index.sources.has(source)) return true;
    const cexSource = cexSourceFromCsvPreset(presetId, rec.sourceKey);
    if (cexSource && index.sources.has(cexSource)) return true;
  }

  const fp = computeRecordFingerprint(rec);
  const fpAvailable = (index.fingerprints.get(fp) ?? 0) - (fpConsumed.get(fp) ?? 0);
  if (fpAvailable > 0) {
    fpConsumed.set(fp, (fpConsumed.get(fp) ?? 0) + 1);
    // Also consume one amount fingerprint slot (same DB entry produces both)
    const afp = computeAmountFingerprint(rec);
    afpConsumed.set(afp, (afpConsumed.get(afp) ?? 0) + 1);
    return true;
  }

  const afp = computeAmountFingerprint(rec);
  const afpAvailable = (index.amountFingerprints.get(afp) ?? 0) - (afpConsumed.get(afp) ?? 0);
  if (afpAvailable > 0) {
    afpConsumed.set(afp, (afpConsumed.get(afp) ?? 0) + 1);
    return true;
  }

  return false;
}

/**
 * Batch duplicate detection for import dialog previews.
 * Tracks consumed counts so multiplicity is respected: if the DB has 1 entry
 * with a fingerprint and the batch has 2 matching records, only the first
 * is flagged as duplicate.
 */
export function markDuplicates(
  records: CsvRecord[],
  presetId: string | undefined,
  index: DedupIndex,
): boolean[] {
  const fpConsumed = new Map<string, number>();
  const afpConsumed = new Map<string, number>();
  return records.map((rec) => checkDuplicate(rec, presetId, index, fpConsumed, afpConsumed));
}

