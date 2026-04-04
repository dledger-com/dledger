import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { renderDescription } from "../types/description-data.js";
import { ensureCurrencyExists } from "../currency-type.js";
import { fetchTransactionHistory } from "./api.js";
import { SolanaHandlerRegistry } from "./handlers/registry.js";
import { genericSolanaHandler } from "./handlers/generic-solana.js";
import { jupiterHandler } from "./handlers/jupiter.js";
import { nativeStakingHandler } from "./handlers/native-staking.js";
import { raydiumHandler } from "./handlers/raydium.js";
import { marinadeHandler } from "./handlers/marinade.js";
import { jitoHandler } from "./handlers/jito.js";
import type { SolanaAccount, SolanaSyncResult, SolTxGroup } from "./types.js";
import type { SolanaHandlerContext } from "./handlers/types.js";

// Well-known program IDs for handler registration
const JUPITER_PROGRAM = "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd";
const JUPITER_V6 = "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P3LsyLph8";

/**
 * Build and configure the default Solana handler registry.
 */
function buildDefaultRegistry(): SolanaHandlerRegistry {
  const registry = new SolanaHandlerRegistry();

  // Register handlers with their program IDs
  registry.register(genericSolanaHandler); // Universal fallback (no programIds)
  registry.register(jupiterHandler, [JUPITER_PROGRAM, JUPITER_V6]);
  registry.register(nativeStakingHandler, [STAKE_PROGRAM]);
  registry.register(raydiumHandler, [RAYDIUM_AMM_V4, RAYDIUM_CLMM]);
  registry.register(marinadeHandler, [MARINADE_PROGRAM]);
  registry.register(jitoHandler, [JITO_STAKE_POOL]);

  return registry;
}

/**
 * Sync a single Solana account — fetch transactions, classify, and post journal entries.
 */
export async function syncSolanaAccount(
  backend: Backend,
  account: SolanaAccount,
  settings: AppSettings,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<SolanaSyncResult> {
  const apiKey = settings.heliusApiKey;
  if (!apiKey) {
    throw new Error("Helius API key is required for Solana sync. Set it in Settings → API Keys.");
  }

  const result: SolanaSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    warnings: [],
  };

  const registry = buildDefaultRegistry();

  // 1. Fetch transactions (incremental from last_signature)
  onProgress?.("Fetching transaction history...");
  let transactions: SolTxGroup[];
  try {
    transactions = await fetchTransactionHistory(account.address, apiKey, {
      lastSignature: account.last_signature ?? undefined,
      signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to fetch Solana transactions: ${msg}`);
  }

  if (transactions.length === 0) {
    onProgress?.("No new transactions found.");
    return result;
  }

  onProgress?.(`Found ${transactions.length} new transactions.`);

  // Sort oldest-first for sequential processing
  transactions.sort((a, b) => a.timestamp - b.timestamp);

  // 2. Build caches for dedup and account/currency ensurance
  const currencySet = new Set(
    (await backend.listCurrencies()).map(c => c.code),
  );
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Collect existing sources for dedup
  const existingSources = new Set<string>();
  const allEntries = await backend.queryJournalEntries({});
  for (const [e] of allEntries) {
    if (e.source.startsWith("solana:")) {
      existingSources.add(e.source);
    }
  }

  // Context helpers
  async function ensureCurrency(code: string, decimals: number, mintAddress?: string): Promise<void> {
    await ensureCurrencyExists(backend, code, currencySet, {
      context: "crypto-chain",
      decimals,
      contractAddress: mintAddress,
      chain: "solana",
    });
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

  async function ensureAccount(fullName: string, date: string): Promise<string> {
    const existing = accountMap.get(fullName);
    if (existing) return existing.id;

    const accountType = inferAccountType(fullName);
    const parts = fullName.split(":");
    let parentId: string | null = null;

    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorName = parts.slice(0, depth).join(":");
      const existingAncestor = accountMap.get(ancestorName);
      if (existingAncestor) {
        parentId = existingAncestor.id;
      } else {
        const id = uuidv7();
        const acc: Account = {
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: ancestorName,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        };
        await backend.createAccount(acc);
        accountMap.set(ancestorName, acc);
        result.accounts_created++;
        parentId = id;
      }
    }

    const id = uuidv7();
    const acc: Account = {
      id,
      parent_id: parentId,
      account_type: accountType,
      name: parts[parts.length - 1],
      full_name: fullName,
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: date,
    };
    await backend.createAccount(acc);
    accountMap.set(fullName, acc);
    result.accounts_created++;
    return id;
  }

  // 3. Process each transaction
  let latestSignature = account.last_signature;

  for (let i = 0; i < transactions.length; i++) {
    if (signal?.aborted) throw new Error("Sync aborted");

    const tx = transactions[i];
    const source = `solana:${tx.signature}`;

    onProgress?.(`Processing transaction ${i + 1}/${transactions.length}...`);

    // Store raw transaction
    try {
      await backend.storeRawTransaction(source, JSON.stringify(tx));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`store raw tx ${tx.signature.slice(0, 16)}...: ${msg}`);
    }

    // Dedup
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      // Track latest signature even for skipped txs
      if (!latestSignature || tx.timestamp > (transactions.find(t => t.signature === latestSignature)?.timestamp ?? 0)) {
        latestSignature = tx.signature;
      }
      continue;
    }

    // Build handler context
    const ctx: SolanaHandlerContext = {
      address: account.address,
      label: account.label,
      backend,
      settings,
      ensureAccount,
      ensureCurrency,
    };

    // Route through handler registry
    const handlerResult = await registry.processTransaction(tx, ctx);

    if (!handlerResult || handlerResult.result.type === "skip") {
      result.transactions_skipped++;
      latestSignature = tx.signature;
      continue;
    }

    const { result: hr } = handlerResult;
    if (hr.type !== "entries" && hr.type !== "review") {
      result.transactions_skipped++;
      latestSignature = tx.signature;
      continue;
    }

    // Post entries
    for (const handlerEntry of hr.entries) {
      const date = handlerEntry.entry.date;

      // Resolve account names to IDs in line items
      const lineItemData: Array<{ account_id: string; currency: string; amount: string; lot_id: string | null }> = [];
      for (const item of handlerEntry.items) {
        const accountId = await ensureAccount(item.account_id, date);
        lineItemData.push({
          account_id: accountId,
          currency: item.currency,
          amount: item.amount,
          lot_id: item.lot_id ?? null,
        });
      }

      const entryId = uuidv7();
      const entry: JournalEntry = {
        id: entryId,
        date,
        description: handlerEntry.entry.description,
        description_data: handlerEntry.entry.description_data ?? undefined,
        status: handlerEntry.entry.status ?? "confirmed",
        source,
        voided_by: null,
        created_at: date,
      };

      const lineItems: LineItem[] = lineItemData.map(item => ({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: item.account_id,
        currency: item.currency,
        amount: item.amount,
        lot_id: item.lot_id,
      }));

      try {
        await backend.postJournalEntry(entry, lineItems);

        // Store metadata
        if (Object.keys(handlerEntry.metadata).length > 0) {
          await backend.setMetadata(entryId, handlerEntry.metadata);
        }

        existingSources.add(source);
        result.transactions_imported++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.warnings.push(`post tx ${tx.signature.slice(0, 16)}...: ${msg}`);
      }
    }

    latestSignature = tx.signature;
  }

  // 4. Update last_signature cursor
  if (latestSignature && latestSignature !== account.last_signature) {
    await backend.updateSolanaLastSignature(account.id, latestSignature);
  }

  return result;
}
