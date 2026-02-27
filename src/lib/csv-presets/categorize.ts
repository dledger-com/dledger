import type { TransactionClassifier, ClassificationResult } from "$lib/ml/classifier.js";
import type { Backend } from "$lib/backend.js";
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

export interface HistoricalExample {
  account: string;        // full account path
  descriptions: string[]; // unique past descriptions assigned to this account
}

/**
 * Build historical examples from past confirmed journal entries.
 * Groups unique transaction descriptions by the accounts they were posted to.
 */
export async function buildHistoricalExamples(
  backend: Backend,
  maxEntries = 500,
  maxPerAccount = 10,
): Promise<HistoricalExample[]> {
  const accounts = await backend.listAccounts();
  const accountMap = new Map<string, string>(); // id → full_name
  for (const a of accounts) {
    accountMap.set(a.id, a.full_name);
  }

  const entries = await backend.queryJournalEntries({
    status: "confirmed",
    limit: maxEntries,
  });

  const descsByAccount = new Map<string, Set<string>>(); // full_name → descriptions

  for (const [entry, items] of entries) {
    if (!entry.description) continue;
    for (const item of items) {
      const fullName = accountMap.get(item.account_id);
      if (!fullName) continue;
      let descs = descsByAccount.get(fullName);
      if (!descs) {
        descs = new Set<string>();
        descsByAccount.set(fullName, descs);
      }
      if (descs.size < maxPerAccount) {
        descs.add(entry.description);
      }
    }
  }

  const result: HistoricalExample[] = [];
  for (const [account, descs] of descsByAccount) {
    if (descs.size > 0) {
      result.push({ account, descriptions: [...descs] });
    }
  }
  return result;
}

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
  backend?: Backend,
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

  // Build historical examples if backend is available
  let historicalExamples: HistoricalExample[] | undefined;
  if (backend) {
    try {
      const allExamples = await buildHistoricalExamples(backend);
      // Filter to only candidate accounts
      const candidateSet = new Set(candidateAccounts);
      historicalExamples = allExamples.filter((ex) => candidateSet.has(ex.account));
      if (debug) {
        const totalDescs = historicalExamples.reduce((s, e) => s + e.descriptions.length, 0);
        console.log(`Historical examples: ${historicalExamples.length} accounts, ${totalDescs} descriptions`);
      }
    } catch (err) {
      if (debug) console.warn("Failed to build historical examples:", err);
      // Graceful degradation — proceed without historical examples
    }
  }

  const results = await classifier.classifyBatch(
    uncategorizedDescriptions,
    candidateAccounts,
    threshold,
    undefined,
    historicalExamples,
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
