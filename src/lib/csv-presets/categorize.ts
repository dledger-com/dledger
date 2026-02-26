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
): Promise<Map<number, ClassificationResult>> {
  const uncategorizedIndices: number[] = [];
  const uncategorizedDescriptions: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // Check if any line uses an Uncategorized account
    const hasUncategorized = rec.lines.some((l) => l.account.endsWith(UNCATEGORIZED_SUFFIX));
    // Also verify that rules don't match (double-check)
    const ruleMatch = matchRule(rec.description, rules);

    if (hasUncategorized && !ruleMatch && rec.description) {
      uncategorizedIndices.push(i);
      uncategorizedDescriptions.push(rec.description);
    }
  }

  if (uncategorizedDescriptions.length === 0) return new Map();

  // Filter accounts to only leaf accounts that aren't Uncategorized
  const candidateAccounts = accounts.filter(
    (a) => !a.endsWith(UNCATEGORIZED_SUFFIX) && a.includes(":"),
  );

  if (candidateAccounts.length === 0) return new Map();

  const results = await classifier.classifyBatch(
    uncategorizedDescriptions,
    candidateAccounts,
    threshold,
  );

  const map = new Map<number, ClassificationResult>();
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.account && result.confidence >= threshold) {
      map.set(uncategorizedIndices[i], result);
    }
  }

  return map;
}
