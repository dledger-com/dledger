/**
 * Shared helpers for blockchain sync functions.
 * Extracted from the common pattern duplicated across all chain sync files.
 */

import { v7 as uuidv7 } from "uuid";
import type { Backend } from "./backend.js";
import type { Account } from "./types/index.js";
import { ensureCurrencyExists } from "./currency-type.js";

/**
 * Ensure an account hierarchy exists, creating missing ancestors.
 * Returns the account ID for the leaf account.
 */
export async function ensureAccountHierarchy(
  backend: Backend,
  fullName: string,
  date: string,
  accountMap: Map<string, Account>,
  counters: { accounts_created: number },
): Promise<string> {
  const existing = accountMap.get(fullName);
  if (existing) return existing.id;

  const parts = fullName.split(":");
  let parentId: string | null = null;

  // Create ancestor accounts if they don't exist
  for (let depth = 1; depth < parts.length; depth++) {
    const ancestorName = parts.slice(0, depth).join(":");
    const ancestor = accountMap.get(ancestorName);
    if (ancestor) {
      parentId = ancestor.id;
    } else {
      const id = uuidv7();
      const acc: Account = {
        id,
        parent_id: parentId,
        account_type: inferAccountType(fullName),
        name: parts[depth - 1],
        full_name: ancestorName,
        allowed_currencies: [],
        is_postable: true,
        is_archived: false,
        created_at: date,
      };
      await backend.createAccount(acc);
      accountMap.set(ancestorName, acc);
      counters.accounts_created++;
      parentId = id;
    }
  }

  // Create the leaf account
  const id = uuidv7();
  const acc: Account = {
    id,
    parent_id: parentId,
    account_type: inferAccountType(fullName),
    name: parts[parts.length - 1],
    full_name: fullName,
    allowed_currencies: [],
    is_postable: true,
    is_archived: false,
    created_at: date,
  };
  await backend.createAccount(acc);
  accountMap.set(fullName, acc);
  counters.accounts_created++;
  return id;
}

function inferAccountType(fullName: string): "asset" | "liability" | "equity" | "revenue" | "expense" {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets": return "asset";
    case "Liabilities": return "liability";
    case "Equity": return "equity";
    case "Income": return "revenue";
    case "Expenses": return "expense";
    default: return "expense";
  }
}

/**
 * Ensure a currency exists in the database.
 * Wraps `ensureCurrencyExists` with a local Set cache to avoid redundant DB calls.
 */
export async function ensureSyncCurrency(
  backend: Backend,
  code: string,
  currencySet: Set<string>,
  decimals?: number,
): Promise<void> {
  await ensureCurrencyExists(backend, code, currencySet, { context: "crypto-chain", decimals: decimals ?? 18 });
}
