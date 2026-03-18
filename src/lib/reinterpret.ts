import { v7 as uuidv7 } from "uuid";
import type { Backend } from "$lib/backend.js";
import type { Account, JournalEntry, LineItem } from "$lib/types/index.js";
import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { matchRule } from "$lib/csv-presets/categorize.js";
import { isSuspenseAccount } from "$lib/matching/suspense.js";
import { parseTags, serializeTags, TAGS_META_KEY } from "$lib/utils/tags.js";

export interface ReinterpretCandidate {
  entry: JournalEntry;
  items: LineItem[];
  suspenseItem: LineItem;
  oldAccountName: string;
  newAccountName: string;
  rule: CsvCategorizationRule;
}

export interface ReinterpretResult {
  candidates: ReinterpretCandidate[];
  totalScanned: number;
  skippedNoRule: number;
  skippedMultiSuspense: number;
}

function inferAccountType(fullName: string): Account["account_type"] {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets": case "Asset": return "asset";
    case "Liabilities": case "Liability": return "liability";
    case "Equity": case "Exchange": return "equity";
    case "Income": case "Revenue": return "revenue";
    case "Expenses": case "Expense": return "expense";
    default: return "expense";
  }
}

async function ensureAccount(
  backend: Backend,
  fullName: string,
  accountCache: Map<string, Account>,
): Promise<string> {
  const existing = accountCache.get(fullName);
  if (existing) return existing.id;

  const parts = fullName.split(":");
  let parentId: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join(":");
    const cached = accountCache.get(path);
    if (cached) {
      parentId = cached.id;
      continue;
    }
    const account: Account = {
      id: uuidv7(),
      parent_id: parentId,
      account_type: inferAccountType(path),
      name: parts[i - 1],
      full_name: path,
      allowed_currencies: [],
      is_postable: i === parts.length,
      is_archived: false,
      created_at: new Date().toISOString().slice(0, 10),
    };
    await backend.createAccount(account);
    accountCache.set(path, account);
    parentId = account.id;
  }
  return parentId!;
}

/** Dry-run: find all entries that can be recategorized. */
export async function findReinterpretCandidates(
  backend: Backend,
  rules: CsvCategorizationRule[],
): Promise<ReinterpretResult> {
  const allEntries = await backend.queryJournalEntries({});
  const accounts = await backend.listAccounts();
  const accountIdToName = new Map<string, string>();
  for (const acc of accounts) {
    accountIdToName.set(acc.id, acc.full_name);
  }

  const candidates: ReinterpretCandidate[] = [];
  let totalScanned = 0;
  let skippedNoRule = 0;
  let skippedMultiSuspense = 0;

  for (const [entry, items] of allEntries) {
    if (entry.voided_by) continue;
    totalScanned++;

    // Find suspense line items
    const suspenseIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const name = accountIdToName.get(items[i].account_id);
      if (name && isSuspenseAccount(name)) {
        suspenseIndices.push(i);
      }
    }

    if (suspenseIndices.length === 0) continue;
    if (suspenseIndices.length > 1) {
      skippedMultiSuspense++;
      continue;
    }

    const suspenseIdx = suspenseIndices[0];
    const suspenseItem = items[suspenseIdx];
    const oldAccountName = accountIdToName.get(suspenseItem.account_id) ?? "";

    // Try to match a categorization rule
    const rule = matchRule(entry.description, rules);
    if (!rule) {
      skippedNoRule++;
      continue;
    }

    // Skip if target is the same as current
    if (rule.account === oldAccountName) continue;

    candidates.push({
      entry,
      items,
      suspenseItem,
      oldAccountName,
      newAccountName: rule.account,
      rule,
    });
  }

  return { candidates, totalScanned, skippedNoRule, skippedMultiSuspense };
}

/** Apply: void-and-repost each candidate with the new account. */
export async function applyReinterpret(
  backend: Backend,
  candidates: ReinterpretCandidate[],
  options?: { onProgress?: (current: number, total: number) => void },
): Promise<{ applied: number; errors: string[] }> {
  const accounts = await backend.listAccounts();
  const accountCache = new Map<string, Account>();
  for (const acc of accounts) {
    accountCache.set(acc.full_name, acc);
  }

  let applied = 0;
  const errors: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    options?.onProgress?.(i, candidates.length);

    try {
      // Ensure target account exists
      const newAccountId = await ensureAccount(backend, c.newAccountName, accountCache);

      // Build new line items with suspense account replaced
      const newEntryId = uuidv7();
      const newItems: LineItem[] = c.items.map((item) => {
        const replaced = item.id === c.suspenseItem.id;
        return {
          id: uuidv7(),
          journal_entry_id: newEntryId,
          account_id: replaced ? newAccountId : item.account_id,
          currency: item.currency,
          amount: item.amount,
          lot_id: item.lot_id,
        };
      });

      // Get existing metadata and links
      const existingMeta = await backend.getMetadata(c.entry.id);
      const existingLinks = await backend.getEntryLinks(c.entry.id);

      // Merge rule tags if the rule has them
      if (c.rule.tags && c.rule.tags.length > 0) {
        const existingTags = parseTags(existingMeta[TAGS_META_KEY]);
        const merged = [...new Set([...existingTags, ...c.rule.tags])];
        existingMeta[TAGS_META_KEY] = serializeTags(merged);
      }

      const newEntry: JournalEntry = {
        id: newEntryId,
        date: c.entry.date,
        description: c.entry.description,
        status: c.entry.status,
        source: c.entry.source,
        voided_by: null,
        created_at: new Date().toISOString().slice(0, 10),
      };

      await backend.editJournalEntry(
        c.entry.id,
        newEntry,
        newItems,
        Object.keys(existingMeta).length > 0 ? existingMeta : undefined,
        existingLinks.length > 0 ? existingLinks : undefined,
      );

      applied++;
    } catch (e) {
      errors.push(`${c.entry.description} (${c.entry.date}): ${String(e)}`);
    }
  }

  options?.onProgress?.(candidates.length, candidates.length);
  return { applied, errors };
}
