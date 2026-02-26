import type { TransactionClassifier, ClassificationResult } from "$lib/ml/classifier.js";
import type { CsvRecord } from "./types.js";

export interface CsvCategorizationRule {
  id: string;
  pattern: string;   // substring match (case-insensitive)
  account: string;   // target account path
}

export function matchRule(
  description: string,
  rules: CsvCategorizationRule[],
): CsvCategorizationRule | null {
  if (!description) return null;
  const lower = description.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern && lower.includes(rule.pattern.toLowerCase())) {
      return rule;
    }
  }
  return null;
}

const UNCATEGORIZED_SUFFIX = ":Uncategorized";

/**
 * Classify uncategorized import records using ML.
 *
 * Rules always take priority — ML only runs on records whose counter-account
 * ends with `:Uncategorized`. Returns a map of record index → ML suggestion
 * (the caller decides whether to apply them).
 */
export async function classifyTransactions(
  records: CsvRecord[],
  rules: CsvCategorizationRule[],
  accounts: string[],
  classifier: TransactionClassifier,
  threshold = 0.5,
  debug = false,
): Promise<Map<number, ClassificationResult>> {
  const uncategorizedIndices: number[] = [];
  const uncategorizedDescriptions: string[] = [];

  let notUncategorized = 0;
  let ruledOut = 0;
  let emptyDescription = 0;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const hasUncategorized = rec.lines.some((l) => l.account.endsWith(UNCATEGORIZED_SUFFIX));
    if (!hasUncategorized) { notUncategorized++; continue; }
    const ruleMatch = matchRule(rec.description, rules);
    if (ruleMatch) { ruledOut++; continue; }
    if (!rec.description) { emptyDescription++; continue; }

    uncategorizedIndices.push(i);
    uncategorizedDescriptions.push(rec.description);
  }

  if (debug) {
    console.group("ML classify");
    console.log(`Input: ${records.length} records, threshold=${threshold}`);
    console.log(
      `Filter: ${uncategorizedDescriptions.length} uncategorized, ` +
      `${ruledOut} ruled out, ${emptyDescription} empty description, ` +
      `${notUncategorized} not uncategorized → ${uncategorizedDescriptions.length} to classify`,
    );
  }

  if (uncategorizedDescriptions.length === 0) {
    if (debug) console.groupEnd();
    return new Map();
  }

  // Filter accounts to only leaf accounts that aren't Uncategorized
  const candidateAccounts = accounts.filter(
    (a) => !a.endsWith(UNCATEGORIZED_SUFFIX) && a.includes(":"),
  );

  if (debug) {
    console.log(`Candidate accounts: ${candidateAccounts.length}`);
  }

  if (candidateAccounts.length === 0) {
    if (debug) console.groupEnd();
    return new Map();
  }

  const results = await classifier.classifyBatch(
    uncategorizedDescriptions,
    candidateAccounts,
    threshold,
  );

  const map = new Map<number, ClassificationResult>();
  let aboveThreshold = 0;

  if (debug) console.log("Raw results:");

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const pass = result.account && result.confidence >= threshold;
    if (pass) {
      map.set(uncategorizedIndices[i], result);
      aboveThreshold++;
    }
    if (debug) {
      const mark = pass ? "✓" : "✗ below threshold";
      console.log(
        `  "${uncategorizedDescriptions[i]}" → ${result.account || "(none)"} ` +
        `(${result.confidence.toFixed(2)}, ${result.method}) ${mark}`,
      );
    }
  }

  if (debug) {
    console.log(`Result: ${aboveThreshold}/${results.length} above threshold`);
    console.groupEnd();
  }

  return map;
}
