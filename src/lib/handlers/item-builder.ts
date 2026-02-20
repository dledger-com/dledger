import Decimal from "decimal.js-light";
import type {
  HandlerContext,
  HandlerEntry,
  TxHashGroup,
  NormalTx,
  InternalTx,
  Erc20Tx,
  Erc721Tx,
  Erc1155Tx,
} from "./types.js";
import type { ChainInfo } from "../types/index.js";
import type { LineItem } from "../types/journal.js";
import {
  weiToNative,
  calculateGasFee,
  shortAddr,
} from "../browser-etherscan.js";
import { ZERO_ADDRESS } from "./addresses.js";

// ---- Core accumulator type ----

/** Account name (not resolved ID), resolved later via resolveToLineItems */
export interface ItemAccum {
  account: string;
  currency: string;
  amount: Decimal;
}

// ---- Per-tx-type builders ----

export function buildNormalTxItems(
  tx: NormalTx,
  addr: string,
  chain: ChainInfo,
  label: string,
): ItemAccum[] {
  const value = weiToNative(tx.value, chain.decimals);
  const gasFee = calculateGasFee(tx.gasUsed, tx.gasPrice, chain.decimals);
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: ItemAccum[] = [];
  const curr = chain.native_currency;

  if (from === addr && to === addr) {
    if (!gasFee.isZero()) {
      items.push({ account: `Expenses:${chainName}:Gas`, currency: curr, amount: gasFee });
      items.push({ account: ourAccount, currency: curr, amount: gasFee.neg() });
    }
  } else if (!to) {
    if (!gasFee.isZero()) {
      items.push({ account: `Expenses:${chainName}:ContractCreation`, currency: curr, amount: gasFee });
      items.push({ account: ourAccount, currency: curr, amount: gasFee.neg() });
    }
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    if (!value.isZero()) {
      items.push({ account: extAccount, currency: curr, amount: value });
    }
    if (!gasFee.isZero()) {
      items.push({ account: `Expenses:${chainName}:Gas`, currency: curr, amount: gasFee });
    }
    const totalOut = value.plus(gasFee);
    if (!totalOut.isZero()) {
      items.push({ account: ourAccount, currency: curr, amount: totalOut.neg() });
    }
  } else if (to === addr) {
    if (!value.isZero()) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      items.push({ account: ourAccount, currency: curr, amount: value });
      items.push({ account: extAccount, currency: curr, amount: value.neg() });
    }
  }

  return items;
}

export function buildInternalTxItems(
  tx: InternalTx,
  addr: string,
  chain: ChainInfo,
  label: string,
): ItemAccum[] {
  const value = weiToNative(tx.value, chain.decimals);
  if (value.isZero()) return [];

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: ItemAccum[] = [];
  const curr = chain.native_currency;

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    items.push({ account: extAccount, currency: curr, amount: value });
    items.push({ account: ourAccount, currency: curr, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    items.push({ account: ourAccount, currency: curr, amount: value });
    items.push({ account: extAccount, currency: curr, amount: value.neg() });
  }

  return items;
}

export async function buildErc20TxItems(
  tx: Erc20Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  ctx: HandlerContext,
): Promise<ItemAccum[]> {
  const decimals = parseInt(tx.tokenDecimal, 10) || 18;
  const value = weiToNative(tx.value, decimals);
  if (value.isZero()) return [];

  const currency = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, decimals);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: ItemAccum[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    items.push({ account: extAccount, currency, amount: value });
    items.push({ account: ourAccount, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    items.push({ account: ourAccount, currency, amount: value });
    items.push({ account: extAccount, currency, amount: value.neg() });
  }

  return items;
}

export async function buildErc721TxItems(
  tx: Erc721Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  ctx: HandlerContext,
): Promise<ItemAccum[]> {
  const value = new Decimal(1);
  const currency = tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, 0);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: ItemAccum[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    items.push({ account: extAccount, currency, amount: value });
    items.push({ account: ourAccount, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    items.push({ account: ourAccount, currency, amount: value });
    items.push({ account: extAccount, currency, amount: value.neg() });
  }

  return items;
}

export async function buildErc1155TxItems(
  tx: Erc1155Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  ctx: HandlerContext,
): Promise<ItemAccum[]> {
  let value: Decimal;
  try {
    value = new Decimal(tx.tokenValue || "0");
  } catch {
    value = new Decimal(0);
  }
  if (value.isZero()) return [];

  const currency = tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, 0);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: ItemAccum[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    items.push({ account: extAccount, currency, amount: value });
    items.push({ account: ourAccount, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    items.push({ account: ourAccount, currency, amount: value });
    items.push({ account: extAccount, currency, amount: value.neg() });
  }

  return items;
}

// ---- Convenience: build all items from a TxHashGroup ----

export async function buildAllGroupItems(
  group: TxHashGroup,
  addr: string,
  chain: ChainInfo,
  label: string,
  ctx: HandlerContext,
): Promise<ItemAccum[]> {
  const allItems: ItemAccum[] = [];

  if (group.normal) {
    allItems.push(...buildNormalTxItems(group.normal, addr, chain, label));
  }

  for (const internal of group.internals) {
    if (internal.isError === "1") continue;
    allItems.push(...buildInternalTxItems(internal, addr, chain, label));
  }

  for (const erc20 of group.erc20s) {
    allItems.push(...await buildErc20TxItems(erc20, addr, chain, label, ctx));
  }

  for (const erc721 of group.erc721s) {
    allItems.push(...await buildErc721TxItems(erc721, addr, chain, label, ctx));
  }

  for (const erc1155 of group.erc1155s) {
    allItems.push(...await buildErc1155TxItems(erc1155, addr, chain, label, ctx));
  }

  return allItems;
}

// ---- Merge items sharing (account, currency), drop zeros ----

export function mergeItemAccums(items: ItemAccum[]): ItemAccum[] {
  const sums = new Map<string, Decimal>();

  for (const item of items) {
    const key = `${item.account}|${item.currency}`;
    const existing = sums.get(key);
    if (existing) {
      sums.set(key, existing.plus(item.amount));
    } else {
      sums.set(key, item.amount);
    }
  }

  const merged: ItemAccum[] = [];
  for (const [key, amount] of sums) {
    if (amount.isZero()) continue;
    const [account, currency] = key.split("|", 2);
    merged.push({ account, currency, amount });
  }

  return merged;
}

// ---- Resolve account names to IDs, return final line items ----

export async function resolveToLineItems(
  items: ItemAccum[],
  date: string,
  ctx: HandlerContext,
): Promise<Omit<LineItem, "id" | "journal_entry_id">[]> {
  const lineItems: Omit<LineItem, "id" | "journal_entry_id">[] = [];

  for (const item of items) {
    const accountId = await ctx.ensureAccount(item.account, date);
    lineItems.push({
      account_id: accountId,
      currency: item.currency,
      amount: item.amount.toString(),
      lot_id: null,
    });
  }

  return lineItems;
}

// ---- Description builders ----

function formatTxDescription(
  tx: NormalTx,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hashShort = tx.hash.length >= 10 ? tx.hash.substring(0, 10) : tx.hash;
  const currency = chain.native_currency;

  if (from === ourAddress && to === ourAddress) {
    return `${currency} self-transfer (${hashShort})`;
  } else if (!to) {
    return `${currency} contract creation (${hashShort})`;
  } else if (from === ourAddress) {
    return `${currency} sent to ${shortAddr(to)} (${hashShort})`;
  } else {
    return `${currency} received from ${shortAddr(from)} (${hashShort})`;
  }
}

function buildTokenDescription(
  group: TxHashGroup,
  ourAddress: string,
  hashShort: string,
): string {
  const total = group.erc20s.length + group.erc721s.length + group.erc1155s.length;

  for (const tx of group.erc20s) {
    const symbol = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  for (const tx of group.erc721s) {
    const symbol = tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  for (const tx of group.erc1155s) {
    const symbol = tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    if (from === ourAddress) {
      const base = `${symbol} sent to ${shortAddr(to)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    } else if (to === ourAddress) {
      const base = `${symbol} received from ${shortAddr(from)} (${hashShort})`;
      return total > 1 ? `${base} + ${total - 1} more` : base;
    }
  }

  return `token transfer (${hashShort})`;
}

export function buildGroupDescription(
  group: TxHashGroup,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;
  const tokenCount = group.erc20s.length + group.erc721s.length + group.erc1155s.length;

  if (group.normal) {
    const base = formatTxDescription(group.normal, ourAddress, chain);
    if (tokenCount > 0) {
      return `${base} + ${tokenCount} token transfer(s)`;
    }
    return base;
  } else if (group.internals.length > 0 && tokenCount === 0) {
    return `${chain.native_currency} internal transfer (${hashShort})`;
  } else {
    return buildTokenDescription(group, ourAddress, hashShort);
  }
}

// ---- ERC20 flow analysis ----

export interface TokenFlow {
  symbol: string;
  amount: Decimal;
  direction: "in" | "out";
  from: string;
  to: string;
  isMint: boolean;
  isBurn: boolean;
  contractAddress: string;
  decimals: number;
}

export function analyzeErc20Flows(erc20s: Erc20Tx[], addr: string): TokenFlow[] {
  const flows: TokenFlow[] = [];

  for (const tx of erc20s) {
    const decimals = parseInt(tx.tokenDecimal, 10) || 18;
    const amount = weiToNative(tx.value, decimals);
    if (amount.isZero()) continue;

    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const symbol = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;

    if (from === addr && to === addr) continue; // self-transfer

    if (from === addr) {
      flows.push({
        symbol,
        amount,
        direction: "out",
        from,
        to,
        isMint: false,
        isBurn: to === ZERO_ADDRESS,
        contractAddress: tx.contractAddress.toLowerCase(),
        decimals,
      });
    } else if (to === addr) {
      flows.push({
        symbol,
        amount,
        direction: "in",
        from,
        to,
        isMint: from === ZERO_ADDRESS,
        isBurn: false,
        contractAddress: tx.contractAddress.toLowerCase(),
        decimals,
      });
    }
  }

  return flows;
}

// ---- Helper to construct HandlerEntry ----

export function buildHandlerEntry(opts: {
  date: string;
  description: string;
  chainId: number;
  hash: string;
  items: Omit<LineItem, "id" | "journal_entry_id">[];
  metadata: Record<string, string>;
}): HandlerEntry {
  return {
    entry: {
      date: opts.date,
      description: opts.description,
      status: "confirmed",
      source: `etherscan:${opts.chainId}:${opts.hash}`,
      voided_by: null,
    },
    items: opts.items,
    metadata: opts.metadata,
  };
}

// ---- Format token amount for descriptions ----

export function formatTokenAmount(amount: Decimal, symbol: string): string {
  // Show reasonable precision — up to 8 significant decimal places
  const str = amount.toFixed(8).replace(/\.?0+$/, "");
  return `${str} ${symbol}`;
}
