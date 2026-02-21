import Decimal from "decimal.js-light";
import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
  Erc20Tx,
} from "./types.js";
import { timestampToDate, weiToNative } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  resolveToLineItems,
  buildHandlerEntry,
  formatTokenAmount,
  type ItemAccum,
} from "./item-builder.js";
import { AAVE, isAavePool, ZERO_ADDRESS } from "./addresses.js";
import { fetchAaveSubgraphData } from "./aave-subgraph.js";
import { shortAddr } from "../browser-etherscan.js";

// ---- Token detection ----

export function isAToken(symbol: string): boolean {
  return /^a(?:(Eth|Arb|Opt|Bas|Pol)[A-Za-z]|[A-Z])/.test(symbol);
}

export function isDebtToken(symbol: string): boolean {
  return /^(variable|stable)Debt/.test(symbol);
}

// ---- Underlying currency extraction ----

/** Map of V3 chain prefixes to wrapped native currency symbols */
const WRAPPED_NATIVE: Record<string, string> = {
  Eth: "WETH",
  Arb: "WETH",
  Opt: "WETH",
  Bas: "WETH",
  Pol: "WPOL",
};

/**
 * Extract underlying currency from aToken symbol.
 * V3: aEthWETH → WETH, aArbUSDC → USDC, aBasDAI → DAI
 * V2: aUSDC → USDC, aWETH → WETH
 */
export function extractATokenUnderlying(symbol: string): string | null {
  // V3 with chain prefix: a + (Eth|Arb|Opt|Bas|Pol) + underlying
  const v3 = symbol.match(/^a(Eth|Arb|Opt|Bas|Pol)(.+)$/);
  if (v3) return v3[2];
  // V2: a + uppercase-starting underlying
  const v2 = symbol.match(/^a([A-Z].+)$/);
  if (v2) return v2[1];
  return null;
}

/**
 * Extract underlying currency from debt token symbol.
 * variableDebtEthUSDC → USDC, stableDebtDAI → DAI
 */
export function extractDebtTokenUnderlying(symbol: string): string | null {
  const m = symbol.match(/^(?:variable|stable)Debt(?:Eth|Arb|Opt|Bas|Pol)?(.+)$/);
  return m ? m[1] : null;
}

// ---- Protocol item building ----

type AaveAction = "SUPPLY" | "WITHDRAW" | "BORROW" | "REPAY" | "CLAIM_REWARDS" | "LIQUIDATION" | "UNKNOWN";

interface ProtocolAction {
  action: AaveAction;
  amount: Decimal;
  currency: string;
  interest?: Decimal;
}

/**
 * Query the current balance of a specific currency in an account.
 * Returns 0 if the account has no balance in that currency.
 */
async function queryAccountCurrencyBalance(
  ctx: HandlerContext,
  accountName: string,
  date: string,
  currency: string,
): Promise<Decimal> {
  const accountId = await ctx.ensureAccount(accountName, date);
  const balances = await ctx.backend.getAccountBalance(accountId);
  const entry = balances.find((b) => b.currency === currency);
  return entry ? new Decimal(entry.amount) : new Decimal(0);
}

/**
 * Build protocol-side ItemAccums from aToken/debtToken ERC20 transfers.
 * Returns the protocol items and any transfers that couldn't be processed
 * (pushed back to regular transfers).
 *
 * When a withdrawal/repay amount exceeds the recorded balance, the excess
 * is recognized as interest (income for supply, expense for borrow).
 */
async function buildProtocolItems(
  protocolTransfers: Erc20Tx[],
  regularTransfers: Erc20Tx[],
  addr: string,
  chain: { name: string; native_currency: string },
  hasNativeEthFlow: boolean,
  ctx: HandlerContext,
): Promise<{ items: ItemAccum[]; actions: ProtocolAction[]; unprocessed: Erc20Tx[] }> {
  const items: ItemAccum[] = [];
  const actions: ProtocolAction[] = [];
  const unprocessed: Erc20Tx[] = [];

  // Collect currencies from regular transfers for native ETH detection
  const regularSymbols = new Set(regularTransfers.map((t) => t.tokenSymbol));

  for (const tx of protocolTransfers) {
    const from = tx.from.toLowerCase();
    const to = tx.to.toLowerCase();
    const decimals = parseInt(tx.tokenDecimal, 10) || 18;
    const amount = weiToNative(tx.value, decimals);
    if (amount.isZero()) continue;

    const isA = isAToken(tx.tokenSymbol);
    let underlying: string | null;
    if (isA) {
      underlying = extractATokenUnderlying(tx.tokenSymbol);
    } else {
      underlying = extractDebtTokenUnderlying(tx.tokenSymbol);
    }

    if (!underlying) {
      // Can't extract underlying — treat as regular transfer
      unprocessed.push(tx);
      continue;
    }

    // Native ETH override: if extracted underlying is a wrapped native symbol,
    // there's no ERC20 transfer for it, AND the wallet side has a native ETH flow
    // (normal tx value or internal tx), use native currency instead of wrapped
    const chainPrefix = tx.tokenSymbol.match(/^a(Eth|Arb|Opt|Bas|Pol)/)?.[1]
      ?? tx.tokenSymbol.match(/^(?:variable|stable)Debt(Eth|Arb|Opt|Bas|Pol)/)?.[1];
    if (chainPrefix && hasNativeEthFlow) {
      const wrappedNative = WRAPPED_NATIVE[chainPrefix];
      if (underlying === wrappedNative && !regularSymbols.has(wrappedNative)) {
        underlying = chain.native_currency;
      }
    }

    if (isA) {
      // aToken transfers
      const isMint = from === ZERO_ADDRESS;
      const isBurn = to === ZERO_ADDRESS;

      if (isMint) {
        // aToken minted → SUPPLY
        // Use the actual underlying transfer amount (not scaled aToken amount)
        // to ensure the entry balances with the wallet-side transfer.
        const underlyingTx = regularTransfers.find((t) =>
          t.tokenSymbol === underlying &&
          t.from.toLowerCase() === addr,
        );
        const supplyAmount = underlyingTx
          ? weiToNative(underlyingTx.value, parseInt(underlyingTx.tokenDecimal, 10) || decimals)
          : amount;
        items.push({ account: "Assets:Aave:Supply", currency: underlying, amount: supplyAmount });
        actions.push({ action: "SUPPLY", amount: supplyAmount, currency: underlying });
      } else if (isBurn) {
        // aToken burned → WITHDRAW with interest detection
        // Use actual underlying transfer amount for balance accuracy
        const underlyingTx = regularTransfers.find((t) =>
          t.tokenSymbol === underlying &&
          t.to.toLowerCase() === addr,
        );
        const withdrawAmount = underlyingTx
          ? weiToNative(underlyingTx.value, parseInt(underlyingTx.tokenDecimal, 10) || decimals)
          : amount;
        const supplyBalance = await queryAccountCurrencyBalance(
          ctx, "Assets:Aave:Supply", timestampToDate(tx.timeStamp), underlying,
        );
        const interest = supplyBalance.isPositive()
          ? withdrawAmount.minus(supplyBalance).gt(0) ? withdrawAmount.minus(supplyBalance) : new Decimal(0)
          : new Decimal(0);
        const principalPart = withdrawAmount.minus(interest);

        if (!principalPart.isZero()) {
          items.push({ account: "Assets:Aave:Supply", currency: underlying, amount: principalPart.neg() });
        }
        if (interest.isPositive()) {
          items.push({ account: "Income:Aave:Interest", currency: underlying, amount: interest.neg() });
        }
        actions.push({ action: "WITHDRAW", amount: withdrawAmount, currency: underlying, interest: interest.isPositive() ? interest : undefined });
      } else if (from === addr) {
        // aToken transferred out (e.g. send aTokens to another address)
        items.push({ account: "Assets:Aave:Supply", currency: underlying, amount: amount.neg() });
        items.push({ account: `Equity:${chain.name}:External:${shortAddr(to)}`, currency: underlying, amount });
      } else if (to === addr) {
        // aToken transferred in (received aTokens)
        items.push({ account: "Assets:Aave:Supply", currency: underlying, amount });
        items.push({ account: `Equity:${chain.name}:External:${shortAddr(from)}`, currency: underlying, amount: amount.neg() });
      }
    } else {
      // Debt token transfers (only mint/burn are meaningful)
      const isMint = from === ZERO_ADDRESS;
      const isBurn = to === ZERO_ADDRESS;

      if (isMint) {
        // debtToken minted → BORROW (liability increases = negative)
        // Use actual underlying transfer amount for balance accuracy
        const underlyingTx = regularTransfers.find((t) =>
          t.tokenSymbol === underlying &&
          t.to.toLowerCase() === addr,
        );
        const borrowAmount = underlyingTx
          ? weiToNative(underlyingTx.value, parseInt(underlyingTx.tokenDecimal, 10) || decimals)
          : amount;
        items.push({ account: "Liabilities:Aave:Borrow", currency: underlying, amount: borrowAmount.neg() });
        actions.push({ action: "BORROW", amount: borrowAmount, currency: underlying });
      } else if (isBurn) {
        // debtToken burned → REPAY with interest detection
        // Use actual underlying transfer amount for balance accuracy
        const underlyingTx = regularTransfers.find((t) =>
          t.tokenSymbol === underlying &&
          t.from.toLowerCase() === addr,
        );
        const repayAmount = underlyingTx
          ? weiToNative(underlyingTx.value, parseInt(underlyingTx.tokenDecimal, 10) || decimals)
          : amount;
        const borrowBalance = await queryAccountCurrencyBalance(
          ctx, "Liabilities:Aave:Borrow", timestampToDate(tx.timeStamp), underlying,
        );
        const absBorrowBalance = borrowBalance.abs();
        const interest = absBorrowBalance.isPositive()
          ? repayAmount.minus(absBorrowBalance).gt(0) ? repayAmount.minus(absBorrowBalance) : new Decimal(0)
          : new Decimal(0);
        const principalPart = repayAmount.minus(interest);

        if (!principalPart.isZero()) {
          items.push({ account: "Liabilities:Aave:Borrow", currency: underlying, amount: principalPart });
        }
        if (interest.isPositive()) {
          items.push({ account: "Expenses:Aave:Interest", currency: underlying, amount: interest });
        }
        actions.push({ action: "REPAY", amount: repayAmount, currency: underlying, interest: interest.isPositive() ? interest : undefined });
      }
      // Non-mint/burn debt token transfers are unusual — ignore
    }
  }

  return { items, actions, unprocessed };
}

// ---- Handler ----

export const aaveHandler: TransactionHandler = {
  id: "aave",
  name: "Aave",
  description: "Interprets Aave lending/borrowing transactions",
  supportedChainIds: [1, 42161, 10, 137, 8453],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (isAavePool(to, ctx.chainId)) return 55;
      if (to === AAVE.WRAPPED_TOKEN_GATEWAY) return 55;
    }

    for (const erc20 of group.erc20s) {
      if (isAToken(erc20.tokenSymbol) || isDebtToken(erc20.tokenSymbol)) {
        return 55;
      }
    }

    return 0;
  },

  async process(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult> {
    const addr = ctx.address.toLowerCase();
    const date = timestampToDate(group.timestamp);
    const hashShort = group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    // Ensure native currency for item building
    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    // Step 1: Partition ERC20 transfers into protocol (aToken/debtToken) and regular
    const protocolTransfers: Erc20Tx[] = [];
    const regularTransfers: Erc20Tx[] = [];
    for (const tx of group.erc20s) {
      if (isAToken(tx.tokenSymbol) || isDebtToken(tx.tokenSymbol)) {
        protocolTransfers.push(tx);
      } else {
        regularTransfers.push(tx);
      }
    }

    // Step 2: Build protocol-side items from aToken/debtToken transfers
    // Detect native ETH flow for wrapped native override
    const hasNativeEthFlow = (group.normal != null && group.normal.value !== "0")
      || group.internals.some((itx) => itx.value !== "0");
    const protocol = await buildProtocolItems(protocolTransfers, regularTransfers, addr, ctx.chain, hasNativeEthFlow, ctx);

    // Ensure currencies for protocol items
    for (const item of protocol.items) {
      // Determine decimals from the original transfer
      const matchingTx = protocolTransfers.find((tx) => {
        const underlying = isAToken(tx.tokenSymbol)
          ? extractATokenUnderlying(tx.tokenSymbol)
          : extractDebtTokenUnderlying(tx.tokenSymbol);
        return underlying === item.currency || item.currency === ctx.chain.native_currency;
      });
      const decimals = matchingTx ? parseInt(matchingTx.tokenDecimal, 10) || 18 : 18;
      await ctx.ensureCurrency(item.currency, decimals);
    }

    // Step 3: Build wallet-side items from filtered group (no protocol tokens)
    const filteredGroup: TxHashGroup = {
      ...group,
      erc20s: [...regularTransfers, ...protocol.unprocessed],
    };
    const allWalletItems = await buildAllGroupItems(filteredGroup, addr, ctx.chain, ctx.label, ctx);
    let walletItems = mergeItemAccums(allWalletItems);

    // Step 4: Consume one matching Equity:External counterparty per protocol item
    // For each protocol item, find and remove ONE wallet Equity:*:External:* item
    // with the same currency AND same sign. Sign matching correctly identifies the
    // counterparty for the Aave interaction (e.g. Supply +1 WETH matches
    // Equity:aToken +1 WETH, but NOT Equity:DEX -1 WETH which is a fund source).
    for (const protocolItem of protocol.items) {
      const idx = walletItems.findIndex((item) =>
        item.account.startsWith("Equity:") &&
        item.account.includes(":External:") &&
        item.currency === protocolItem.currency &&
        item.amount.isPositive() === protocolItem.amount.isPositive(),
      );
      if (idx !== -1) {
        walletItems.splice(idx, 1);
      }
    }

    // Step 5: Reclassify remaining Equity:External:* items
    // If no protocol actions detected (pure rewards), reclassify as income
    if (protocol.actions.length === 0) {
      const hasOnlyInflows = walletItems.some(
        (i) => i.account.startsWith("Equity:") && i.account.includes(":External:") && i.amount.isNegative(),
      ) && !walletItems.some(
        (i) => i.account.startsWith("Equity:") && i.account.includes(":External:") && i.amount.isPositive(),
      );
      if (hasOnlyInflows) {
        walletItems = walletItems.map((item) => {
          if (item.account.startsWith("Equity:") && item.account.includes(":External:")) {
            return { ...item, account: "Income:Aave:Rewards" };
          }
          return item;
        });
      }
    }

    // Step 6: Merge protocol items + remaining wallet items
    const merged = mergeItemAccums([...protocol.items, ...walletItems]);

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Step 7: Build description from protocol actions
    let description: string;
    if (protocol.actions.length > 0) {
      const actionParts = protocol.actions.map((a) => {
        const label = a.action === "SUPPLY" ? "Supply"
          : a.action === "WITHDRAW" ? "Withdraw"
          : a.action === "BORROW" ? "Borrow"
          : a.action === "REPAY" ? "Repay"
          : "Interact";
        let part = `${label} ${formatTokenAmount(a.amount, a.currency)}`;
        if (a.interest) {
          part += ` (+${formatTokenAmount(a.interest, a.currency)} interest)`;
        }
        return part;
      });
      description = `Aave: ${actionParts.join(" + ")} (${hashShort})`;
    } else {
      // Claim rewards or unknown — check wallet items for inflows
      const rewardItems = walletItems.filter(
        (i) => i.account === "Income:Aave:Rewards" || (i.account.startsWith("Assets:") && i.amount.isPositive()),
      );
      if (rewardItems.length > 0) {
        const rewardAsset = rewardItems.find((i) => i.account.startsWith("Assets:"));
        const amountStr = rewardAsset
          ? ` ${formatTokenAmount(rewardAsset.amount, rewardAsset.currency)}`
          : "";
        description = `Aave: Claim Rewards${amountStr} (${hashShort})`;
      } else {
        description = `Aave: Interact (${hashShort})`;
      }
    }

    // Determine actions for metadata
    let actionSet = protocol.actions.length > 0
      ? [...new Set(protocol.actions.map((a) => a.action))].join(",")
      : walletItems.some((i) => i.account === "Income:Aave:Rewards")
        ? "CLAIM_REWARDS"
        : "UNKNOWN";

    // Determine version
    const isV2 = group.normal
      ? group.normal.to.toLowerCase() === AAVE.V2_POOL
      : false;
    const version = isV2 ? "V2" : "V3";

    const metadata: Record<string, string> = {
      handler: "aave",
      "handler:action": actionSet,
      "handler:version": version,
    };

    // Add interest metadata when detected
    for (const a of protocol.actions) {
      if (a.interest) {
        const key = a.action === "WITHDRAW"
          ? `handler:interest_earned_${a.currency.toLowerCase()}`
          : `handler:interest_paid_${a.currency.toLowerCase()}`;
        metadata[key] = a.interest.toString();
      }
    }

    // Enrichment: fetch historical data from Aave protocol subgraphs (opt-in)
    if (ctx.enrichment && protocol.actions.length > 0) {
      try {
        const subgraphData = await fetchAaveSubgraphData(
          ctx.settings.theGraphApiKey, ctx.chainId, group.hash, isV2,
        );
        if (subgraphData) {
          metadata["handler:supply_apy"] = subgraphData.supply_apy;
          metadata["handler:borrow_apy"] = subgraphData.borrow_apy;
          metadata["handler:asset_price_usd"] = subgraphData.asset_price_usd;
          metadata["handler:utilization_rate"] = subgraphData.utilization_rate;
          metadata["handler:total_liquidity"] = subgraphData.total_liquidity;

          if (subgraphData.liquidation) {
            const liq = subgraphData.liquidation;
            metadata["handler:liquidator"] = liq.liquidator;
            metadata["handler:collateral_asset"] = liq.collateral_asset;
            metadata["handler:collateral_amount"] = liq.collateral_amount;
            metadata["handler:collateral_price_usd"] = liq.collateral_price_usd;
            metadata["handler:debt_asset"] = liq.debt_asset;
            metadata["handler:debt_amount"] = liq.debt_amount;
            metadata["handler:debt_price_usd"] = liq.debt_price_usd;
            actionSet = "LIQUIDATION";
            metadata["handler:action"] = actionSet;
            description = `Aave: Liquidation — ${liq.collateral_amount} ${liq.collateral_asset} seized, ${liq.debt_amount} ${liq.debt_asset} repaid (${hashShort})`;
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        metadata["handler:warnings"] = `Aave subgraph enrichment failed: ${msg}`;
      }
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
    });

    return { type: "entries", entries: [handlerEntry] };
  },
};
