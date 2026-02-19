import Decimal from "decimal.js-light";
import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  HandlerEntry,
  TxHashGroup,
  NormalTx,
  InternalTx,
  Erc20Tx,
  Erc721Tx,
  Erc1155Tx,
} from "./types.js";
import type { ChainInfo } from "../types/index.js";
import {
  weiToNative,
  calculateGasFee,
  timestampToDate,
  shortAddr,
} from "../browser-etherscan.js";

// ---- Item type (pipeline assigns id and journal_entry_id later) ----

interface RawItem {
  account_id: string;
  currency: string;
  amount: Decimal;
}

// ---- Description helpers (ported from browser-etherscan.ts) ----

function formatTxDescription(
  tx: NormalTx,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const hashShort =
    tx.hash.length >= 10 ? tx.hash.substring(0, 10) : tx.hash;
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
  const total =
    group.erc20s.length + group.erc721s.length + group.erc1155s.length;

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
    const symbol =
      tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
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
    const symbol =
      tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
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

function buildGroupDescription(
  group: TxHashGroup,
  ourAddress: string,
  chain: ChainInfo,
): string {
  const hashShort =
    group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;
  const tokenCount =
    group.erc20s.length + group.erc721s.length + group.erc1155s.length;

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

// ---- Item builders ----

async function buildNormalItems(
  tx: NormalTx,
  addr: string,
  chain: ChainInfo,
  label: string,
  date: string,
  ctx: HandlerContext,
): Promise<RawItem[]> {
  const value = weiToNative(tx.value, chain.decimals);
  const gasFee = calculateGasFee(tx.gasUsed, tx.gasPrice, chain.decimals);
  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: RawItem[] = [];
  const curr = chain.native_currency;

  if (from === addr && to === addr) {
    if (!gasFee.isZero()) {
      const gasAccId = await ctx.ensureAccount(
        `Expenses:${chainName}:Gas`,
        date,
      );
      const ourAccId = await ctx.ensureAccount(ourAccount, date);
      items.push({ account_id: gasAccId, currency: curr, amount: gasFee });
      items.push({ account_id: ourAccId, currency: curr, amount: gasFee.neg() });
    }
  } else if (!to) {
    if (!gasFee.isZero()) {
      const ccAccId = await ctx.ensureAccount(
        `Expenses:${chainName}:ContractCreation`,
        date,
      );
      const ourAccId = await ctx.ensureAccount(ourAccount, date);
      items.push({ account_id: ccAccId, currency: curr, amount: gasFee });
      items.push({ account_id: ourAccId, currency: curr, amount: gasFee.neg() });
    }
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    if (!value.isZero())
      items.push({ account_id: extAccId, currency: curr, amount: value });
    if (!gasFee.isZero()) {
      const gasAccId = await ctx.ensureAccount(
        `Expenses:${chainName}:Gas`,
        date,
      );
      items.push({ account_id: gasAccId, currency: curr, amount: gasFee });
    }
    const totalOut = value.plus(gasFee);
    if (!totalOut.isZero())
      items.push({ account_id: ourAccId, currency: curr, amount: totalOut.neg() });
  } else if (to === addr) {
    if (!value.isZero()) {
      const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
      const extAccId = await ctx.ensureAccount(extAccount, date);
      const ourAccId = await ctx.ensureAccount(ourAccount, date);
      items.push({ account_id: ourAccId, currency: curr, amount: value });
      items.push({ account_id: extAccId, currency: curr, amount: value.neg() });
    }
  }

  return items;
}

async function buildInternalItems(
  tx: InternalTx,
  addr: string,
  chain: ChainInfo,
  label: string,
  date: string,
  ctx: HandlerContext,
): Promise<RawItem[]> {
  const value = weiToNative(tx.value, chain.decimals);
  if (value.isZero()) return [];

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: RawItem[] = [];
  const curr = chain.native_currency;

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: extAccId, currency: curr, amount: value });
    items.push({ account_id: ourAccId, currency: curr, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: ourAccId, currency: curr, amount: value });
    items.push({ account_id: extAccId, currency: curr, amount: value.neg() });
  }

  return items;
}

async function buildErc20Items(
  tx: Erc20Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  date: string,
  ctx: HandlerContext,
): Promise<RawItem[]> {
  const decimals = parseInt(tx.tokenDecimal, 10) || 18;
  const value = weiToNative(tx.value, decimals);
  if (value.isZero()) return [];

  const currency = tx.tokenSymbol || `ERC20:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, decimals);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: RawItem[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: extAccId, currency, amount: value });
    items.push({ account_id: ourAccId, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: ourAccId, currency, amount: value });
    items.push({ account_id: extAccId, currency, amount: value.neg() });
  }

  return items;
}

async function buildErc721Items(
  tx: Erc721Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  date: string,
  ctx: HandlerContext,
): Promise<RawItem[]> {
  const value = new Decimal(1);
  const currency = tx.tokenSymbol || `NFT:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, 0);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: RawItem[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: extAccId, currency, amount: value });
    items.push({ account_id: ourAccId, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: ourAccId, currency, amount: value });
    items.push({ account_id: extAccId, currency, amount: value.neg() });
  }

  return items;
}

async function buildErc1155Items(
  tx: Erc1155Tx,
  addr: string,
  chain: ChainInfo,
  label: string,
  date: string,
  ctx: HandlerContext,
): Promise<RawItem[]> {
  let value: Decimal;
  try {
    value = new Decimal(tx.tokenValue || "0");
  } catch {
    value = new Decimal(0);
  }
  if (value.isZero()) return [];

  const currency =
    tx.tokenSymbol || `ERC1155:${shortAddr(tx.contractAddress)}`;
  await ctx.ensureCurrency(currency, 0);

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const chainName = chain.name;
  const ourAccount = `Assets:${chainName}:${label}`;
  const items: RawItem[] = [];

  if (from === addr && to === addr) {
    // Self-transfer: no net effect
  } else if (from === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(to)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: extAccId, currency, amount: value });
    items.push({ account_id: ourAccId, currency, amount: value.neg() });
  } else if (to === addr) {
    const extAccount = `Equity:${chainName}:External:${shortAddr(from)}`;
    const extAccId = await ctx.ensureAccount(extAccount, date);
    const ourAccId = await ctx.ensureAccount(ourAccount, date);
    items.push({ account_id: ourAccId, currency, amount: value });
    items.push({ account_id: extAccId, currency, amount: value.neg() });
  }

  return items;
}

// ---- Item merging ----

function mergeItems(
  items: RawItem[],
): Omit<import("../types/index.js").LineItem, "id" | "journal_entry_id">[] {
  const sums = new Map<string, Decimal>();

  for (const item of items) {
    const key = `${item.account_id}|${item.currency}`;
    const existing = sums.get(key);
    if (existing) {
      sums.set(key, existing.plus(item.amount));
    } else {
      sums.set(key, item.amount);
    }
  }

  const merged: Omit<
    import("../types/index.js").LineItem,
    "id" | "journal_entry_id"
  >[] = [];
  for (const [key, amount] of sums) {
    if (amount.isZero()) continue;
    const [accountId, currency] = key.split("|", 2);
    merged.push({
      account_id: accountId,
      currency,
      amount: amount.toString(),
      lot_id: null,
    });
  }

  return merged;
}

// ---- Handler ----

export const GenericEtherscanHandler: TransactionHandler = {
  id: "generic-etherscan",
  name: "Generic Etherscan",
  description: "Default handler for all blockchain transactions",
  supportedChainIds: [],

  match(_group: TxHashGroup, _ctx: HandlerContext): number {
    return 1;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    // Skip if normal tx has isError == "1"
    if (group.normal && group.normal.isError === "1") {
      return { type: "skip", reason: "failed transaction" };
    }

    const date = timestampToDate(group.timestamp);
    const addr = ctx.address;
    const chain = ctx.chain;
    const label = ctx.label;
    const allItems: RawItem[] = [];

    // Build normal items
    if (group.normal) {
      const items = await buildNormalItems(
        group.normal,
        addr,
        chain,
        label,
        date,
        ctx,
      );
      allItems.push(...items);
    }

    // Build internal items (skip isError == "1")
    for (const internal of group.internals) {
      if (internal.isError === "1") continue;
      const items = await buildInternalItems(
        internal,
        addr,
        chain,
        label,
        date,
        ctx,
      );
      allItems.push(...items);
    }

    // Build ERC20 items
    for (const erc20 of group.erc20s) {
      const items = await buildErc20Items(
        erc20,
        addr,
        chain,
        label,
        date,
        ctx,
      );
      allItems.push(...items);
    }

    // Build ERC721 items
    for (const erc721 of group.erc721s) {
      const items = await buildErc721Items(
        erc721,
        addr,
        chain,
        label,
        date,
        ctx,
      );
      allItems.push(...items);
    }

    // Build ERC1155 items
    for (const erc1155 of group.erc1155s) {
      const items = await buildErc1155Items(
        erc1155,
        addr,
        chain,
        label,
        date,
        ctx,
      );
      allItems.push(...items);
    }

    // Merge items sharing the same (account_id, currency)
    const merged = mergeItems(allItems);
    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    // Build description
    const description = buildGroupDescription(group, addr, chain);

    // Build source string
    const source = `etherscan:${ctx.chainId}:${group.hash}`;

    const handlerEntry: HandlerEntry = {
      entry: {
        date,
        description,
        status: "confirmed",
        source,
        voided_by: null,
      },
      items: merged,
      metadata: { handler: "generic-etherscan" },
    };

    return { type: "entries", entries: [handlerEntry] };
  },
};
