import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { mergeItemAccums } from "../handlers/item-builder.js";
import { renderDescription, type DescriptionData } from "../types/description-data.js";
import { classifyBtcTx } from "./classify.js";
import { buildBtcItems, shortAddr } from "./entries.js";
import { fetchAddressTxs, fetchAddressInfo } from "./api.js";
import { deriveAddresses } from "./derive.js";
import type { BitcoinAccount, BitcoinSyncResult, BtcApiTx } from "./types.js";

const GAP_LIMIT = 20;
const MAX_DERIVATION = 1000;

/**
 * Sync a single Bitcoin account — fetch transactions, classify, and post journal entries.
 */
export async function syncBitcoinAccount(
  backend: Backend,
  account: BitcoinAccount,
  allAccounts: BitcoinAccount[],
  settings: AppSettings,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BitcoinSyncResult> {
  const baseUrl = settings.btcExplorerUrl || "https://mempool.space";

  const result: BitcoinSyncResult = {
    transactions_imported: 0,
    transactions_skipped: 0,
    accounts_created: 0,
    addresses_derived: 0,
    warnings: [],
  };

  // 1. Build owned address set across ALL bitcoin accounts
  const ownedAddresses = new Set<string>();
  const addressToWallet = new Map<string, string>();

  for (const acc of allAccounts) {
    const addrs = acc.account_type === "address"
      ? [acc.address_or_xpub]
      : await backend.getBtcTrackedAddresses(acc.id);

    for (const addr of addrs) {
      ownedAddresses.add(addr);
      addressToWallet.set(addr, acc.label);
    }
  }

  // 2. For the account being synced: derive addresses if xpub
  let accountAddresses: string[];

  if (account.account_type === "address") {
    accountAddresses = [account.address_or_xpub];
  } else {
    // xpub/ypub/zpub — run gap-limit discovery
    onProgress?.("Deriving addresses...");

    const bip = account.derivation_bip ?? 84;

    for (const chain of [0, 1]) {
      const chainName = chain === 0 ? "receive" : "change";
      let lastKnownIndex = chain === 0
        ? account.last_receive_index
        : account.last_change_index;

      let consecutiveEmpty = 0;
      let index = lastKnownIndex + 1;
      let lastUsedIndex = lastKnownIndex;

      while (consecutiveEmpty < GAP_LIMIT && index < lastKnownIndex + 1 + MAX_DERIVATION) {
        if (signal?.aborted) throw new Error("Sync aborted");

        const batchSize = Math.min(GAP_LIMIT, MAX_DERIVATION - (index - lastKnownIndex - 1));
        const addresses = await deriveAddresses(
          account.address_or_xpub,
          bip,
          chain,
          index,
          batchSize,
          account.network,
        );

        // Store derived addresses
        const derivedBatch = addresses.map((addr, i) => ({
          address: addr,
          change: chain,
          index: index + i,
        }));
        await backend.storeBtcDerivedAddresses(account.id, derivedBatch);
        result.addresses_derived += addresses.length;

        for (let i = 0; i < addresses.length; i++) {
          if (signal?.aborted) throw new Error("Sync aborted");

          const addr = addresses[i];
          ownedAddresses.add(addr);
          addressToWallet.set(addr, account.label);

          onProgress?.(`Scanning ${chainName} address ${index + i}...`);

          try {
            const info = await fetchAddressInfo(addr, baseUrl, signal);
            if (info.tx_count > 0) {
              consecutiveEmpty = 0;
              lastUsedIndex = index + i;
            } else {
              consecutiveEmpty++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            result.warnings.push(`address scan ${addr}: ${msg}`);
            consecutiveEmpty++;
          }

          if (consecutiveEmpty >= GAP_LIMIT) break;
        }

        index += batchSize;
      }

      // Update derivation index for this chain
      if (chain === 0) {
        await backend.updateBtcDerivationIndex(
          account.id,
          Math.max(lastUsedIndex, account.last_receive_index),
          account.last_change_index,
        );
      } else {
        // Re-read to get current receive index
        await backend.updateBtcDerivationIndex(
          account.id,
          Math.max(account.last_receive_index, lastKnownIndex),
          Math.max(lastUsedIndex, account.last_change_index),
        );
      }
    }

    accountAddresses = await backend.getBtcTrackedAddresses(account.id);
  }

  // 3. Fetch transactions for all addresses
  const allTxs = new Map<string, BtcApiTx>();

  for (let i = 0; i < accountAddresses.length; i++) {
    if (signal?.aborted) throw new Error("Sync aborted");

    const addr = accountAddresses[i];
    onProgress?.(`Fetching transactions for address ${i + 1}/${accountAddresses.length}...`);

    try {
      const txs = await fetchAddressTxs(addr, baseUrl, signal);
      for (const tx of txs) {
        if (!allTxs.has(tx.txid)) {
          allTxs.set(tx.txid, tx);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`fetch txs for ${addr}: ${msg}`);
    }
  }

  // Sort by block_time ascending (unconfirmed at the end)
  const sortedTxs = Array.from(allTxs.values()).sort((a, b) => {
    const aTime = a.status.block_time ?? Infinity;
    const bTime = b.status.block_time ?? Infinity;
    return aTime - bTime;
  });

  // 4. Build caches for account/currency ensurance
  const currencySet = new Set(
    (await backend.listCurrencies()).map((c) => c.code),
  );
  const accountMap = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    accountMap.set(acc.full_name, acc);
  }

  // Collect existing sources for dedup
  const existingSources = new Set<string>();
  const allEntries = await backend.queryJournalEntries({});
  for (const [e] of allEntries) {
    if (e.source.startsWith("bitcoin:")) {
      existingSources.add(e.source);
    }
  }

  // Context helpers
  async function ensureCurrency(code: string, decimals: number): Promise<void> {
    if (currencySet.has(code)) return;
    await backend.createCurrency({
      code,
      asset_type: "",
      param: "",
      name: code,
      decimal_places: decimals,
      is_base: false,
    });
    currencySet.add(code);
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

  // Ensure BTC currency exists
  await ensureCurrency("BTC", 8);

  // 5. Process each transaction
  for (let i = 0; i < sortedTxs.length; i++) {
    if (signal?.aborted) throw new Error("Sync aborted");

    const tx = sortedTxs[i];
    const source = `bitcoin:${tx.txid}`;

    onProgress?.(`Processing transaction ${i + 1}/${sortedTxs.length}...`);

    // Store raw transaction
    try {
      await backend.storeRawTransaction(source, JSON.stringify(tx));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`store raw tx ${tx.txid}: ${msg}`);
    }

    // Dedup
    if (existingSources.has(source)) {
      result.transactions_skipped++;
      continue;
    }

    // Skip unconfirmed transactions
    if (!tx.status.confirmed || !tx.status.block_time) {
      result.transactions_skipped++;
      continue;
    }

    // Classify
    const classification = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    // Build items
    const items = buildBtcItems(tx, classification, addressToWallet);
    const merged = mergeItemAccums(items);

    if (merged.length === 0) {
      result.transactions_skipped++;
      continue;
    }

    // Build date
    const date = new Date(tx.status.block_time * 1000).toISOString().split("T")[0];

    // Resolve accounts
    const lineItemData: Array<{ account_id: string; currency: string; amount: string; lot_id: string | null }> = [];
    for (const item of merged) {
      const accountId = await ensureAccount(item.account, date);
      lineItemData.push({
        account_id: accountId,
        currency: item.currency,
        amount: item.amount.toString(),
        lot_id: null,
      });
    }

    // Build description
    const counterparty = classification.type === "send"
      ? shortAddr(classification.externalRecipients[0] ?? "")
      : classification.type === "receive"
        ? shortAddr(tx.vin[0]?.prevout?.scriptpubkey_address ?? "")
        : undefined;

    const descriptionData: DescriptionData = {
      type: "btc-transfer",
      direction: classification.type === "send" ? "sent"
        : classification.type === "receive" ? "received"
        : classification.type,
      counterparty: counterparty || undefined,
      txid: tx.txid,
    };

    const description = renderDescription(descriptionData);

    // Post entry
    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      description_data: JSON.stringify(descriptionData),
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    const lineItems: LineItem[] = lineItemData.map((item) => ({
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
      const meta: Record<string, string> = {
        txid: tx.txid,
        "btc:block_time": String(tx.status.block_time),
        "btc:fee_sats": String(tx.fee),
        "btc:input_count": String(tx.vin.length),
        "btc:output_count": String(tx.vout.length),
      };
      if (tx.status.block_height) {
        meta["btc:block_height"] = String(tx.status.block_height);
      }
      await backend.setMetadata(entryId, meta);

      existingSources.add(source);
      result.transactions_imported++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.warnings.push(`post tx ${tx.txid}: ${msg}`);
    }
  }

  return result;
}
