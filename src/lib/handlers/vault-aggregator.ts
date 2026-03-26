import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "./types.js";
import { timestampToDate } from "../browser-etherscan.js";
import {
  buildAllGroupItems,
  mergeItemAccums,
  remapCounterpartyAccounts,
  resolveToLineItems,
  buildHandlerEntry,
  analyzeErc20Flows,
  formatTokenAmount,
  type TokenFlow,
} from "./item-builder.js";
import { VAULT_AGGREGATORS } from "./addresses.js";
import { defiIncome } from "../accounts/paths.js";

// ---- Protocol detection from token symbol ----

type VaultProtocol = "Beefy" | "Harvest" | "Sommelier" | "Badger" | "Unknown";

const PROTOCOL_PATTERNS: { pattern: RegExp; protocol: VaultProtocol }[] = [
  { pattern: /^moo/, protocol: "Beefy" },
  { pattern: /^f[A-Z]/, protocol: "Harvest" },
  { pattern: /^b[a-z]*[A-Z]/, protocol: "Badger" },
];

function detectProtocol(symbols: string[], contractAddresses: string[]): VaultProtocol {
  for (const sym of symbols) {
    for (const { pattern, protocol } of PROTOCOL_PATTERNS) {
      if (pattern.test(sym)) return protocol;
    }
  }

  const lowerAddrs = contractAddresses.map((a) => a.toLowerCase());
  if (lowerAddrs.includes(VAULT_AGGREGATORS.HARVEST_CONTROLLER)) return "Harvest";
  if (lowerAddrs.includes(VAULT_AGGREGATORS.SOMMELIER_REGISTRY)) return "Sommelier";
  if (lowerAddrs.includes(VAULT_AGGREGATORS.BADGER_SETT_VAULT)) return "Badger";

  return "Unknown";
}

function isVaultShareToken(symbol: string): boolean {
  return PROTOCOL_PATTERNS.some(({ pattern }) => pattern.test(symbol));
}

// ---- Action classification ----

type VaultAction = "DEPOSIT" | "WITHDRAW" | "CLAIM_REWARDS" | "UNKNOWN";

const ACTION_LABELS: Record<VaultAction, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdraw",
  CLAIM_REWARDS: "Claim Rewards",
  UNKNOWN: "Interact",
};

function classifyAction(flows: TokenFlow[]): VaultAction {
  const vaultMinted = flows.some((f) => isVaultShareToken(f.symbol) && f.isMint);
  const vaultBurned = flows.some((f) => isVaultShareToken(f.symbol) && f.isBurn);
  const hasNonVaultInflow = flows.some(
    (f) => f.direction === "in" && !isVaultShareToken(f.symbol),
  );
  const hasNonVaultOutflow = flows.some(
    (f) => f.direction === "out" && !isVaultShareToken(f.symbol),
  );

  // DEPOSIT: vault share token minted + underlying outflow
  if (vaultMinted && hasNonVaultOutflow) return "DEPOSIT";

  // WITHDRAW: vault share token burned + underlying inflow
  if (vaultBurned && hasNonVaultInflow) return "WITHDRAW";

  // CLAIM_REWARDS: reward tokens with no vault shares minted/burned
  if (!vaultMinted && !vaultBurned && hasNonVaultInflow && !hasNonVaultOutflow) {
    return "CLAIM_REWARDS";
  }

  return "UNKNOWN";
}

// ---- Find underlying token flow ----

function findUnderlyingFlow(flows: TokenFlow[]): TokenFlow | undefined {
  return flows.find((f) => !isVaultShareToken(f.symbol));
}

// ---- Handler ----

export const vaultAggregatorHandler: TransactionHandler = {
  id: "vault-aggregator",
  name: "Vault Aggregator",
  description: "Interprets vault deposit/withdraw transactions for Beefy, Harvest, Sommelier, Badger",
  website: "https://beefy.finance",
  supportedChainIds: [1, 56, 137, 42161, 10, 8453, 43114],

  match(group: TxHashGroup, ctx: HandlerContext): number {
    // Check ERC20 symbols for vault share tokens
    for (const erc20 of group.erc20s) {
      if (isVaultShareToken(erc20.tokenSymbol)) return 53;
    }

    // Check normal tx target for known contracts
    if (group.normal) {
      const to = group.normal.to.toLowerCase();
      if (
        to === VAULT_AGGREGATORS.HARVEST_CONTROLLER ||
        to === VAULT_AGGREGATORS.SOMMELIER_REGISTRY ||
        to === VAULT_AGGREGATORS.BADGER_SETT_VAULT
      ) {
        return 53;
      }
    }

    // Check ERC20 from/to for known contracts
    for (const erc20 of group.erc20s) {
      const from = erc20.from.toLowerCase();
      const to = erc20.to.toLowerCase();
      if (
        from === VAULT_AGGREGATORS.HARVEST_CONTROLLER ||
        to === VAULT_AGGREGATORS.HARVEST_CONTROLLER ||
        from === VAULT_AGGREGATORS.SOMMELIER_REGISTRY ||
        to === VAULT_AGGREGATORS.SOMMELIER_REGISTRY ||
        from === VAULT_AGGREGATORS.BADGER_SETT_VAULT ||
        to === VAULT_AGGREGATORS.BADGER_SETT_VAULT
      ) {
        return 53;
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
    const hashShort =
      group.hash.length >= 10 ? group.hash.substring(0, 10) : group.hash;

    const flows = analyzeErc20Flows(group.erc20s, addr);
    const action = classifyAction(flows);

    // Detect protocol from token symbols and contract addresses
    const symbols = group.erc20s.map((e) => e.tokenSymbol);
    const contractAddresses = [
      ...(group.normal ? [group.normal.to] : []),
      ...group.erc20s.map((e) => e.contractAddress),
    ];
    const protocol = detectProtocol(symbols, contractAddresses);

    await ctx.ensureCurrency(ctx.chain.native_currency, ctx.chain.decimals);

    const allItems = await buildAllGroupItems(
      group,
      addr,
      ctx.chain,
      ctx.label,
      ctx,
    );
    let merged = mergeItemAccums(allItems);

    // Reclassify counterparty accounts based on action
    if (action === "CLAIM_REWARDS") {
      merged = remapCounterpartyAccounts(merged, [
        { from: "Equity:*:External:*", to: defiIncome(protocol, "Rewards") },
      ]);
    }

    if (merged.length === 0) {
      return { type: "skip", reason: "no net movement" };
    }

    const lineItems = await resolveToLineItems(merged, date, ctx);

    // Build description
    const underlying = findUnderlyingFlow(flows);
    const amountStr = underlying
      ? ` ${formatTokenAmount(underlying.amount, underlying.symbol)}`
      : "";
    const description = `${protocol}: ${ACTION_LABELS[action]}${amountStr} (${hashShort})`;

    const metadata: Record<string, string> = {
      handler: "vault-aggregator",
      "handler:action": action,
      "handler:protocol": protocol,
    };

    // Find vault share token for metadata
    const vaultTokenTx = group.erc20s.find((tx) => isVaultShareToken(tx.tokenSymbol));
    if (vaultTokenTx) {
      metadata["handler:vault_token"] = vaultTokenTx.tokenSymbol;
    }

    const handlerEntry = buildHandlerEntry({
      date,
      description,
      descriptionData: { type: "defi", protocol, action: ACTION_LABELS[action], chain: ctx.chain.name, txHash: group.hash },
      chainId: ctx.chainId,
      hash: group.hash,
      items: lineItems,
      metadata,
      sourcePrefix: ctx.sourcePrefix,
    });

    // Currency hints: vault share tokens should not fetch exchange rates
    const vaultTokenCurrencies = allItems
      .map((i) => i.currency)
      .filter((c) => isVaultShareToken(c))
      .filter((c, i, arr) => arr.indexOf(c) === i);

    const currencyHints: Record<string, null> = {};
    for (const token of vaultTokenCurrencies) {
      currencyHints[token] = null;
    }

    return { type: "entries", entries: [handlerEntry], currencyHints };
  },
};
