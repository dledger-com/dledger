import type { Backend } from "$lib/backend.js";
import type { Account, CurrencyBalance } from "$lib/types/index.js";

export interface DefiPosition {
  protocol: string;
  action: string;
  account: string;
  currency: string;
  balance: string;
  baseValue?: string;
}

export interface ProtocolSummary {
  protocol: string;
  displayName: string;
  supplies: DefiPosition[];
  borrows: DefiPosition[];
  rewards: DefiPosition[];
  totalBaseValue?: string;
}

interface ProtocolPattern {
  account?: RegExp;
  currency?: RegExp;
  category: "supplies" | "borrows" | "rewards";
}

interface ProtocolDef {
  displayName: string;
  patterns: ProtocolPattern[];
}

const PROTOCOL_MAP: Record<string, ProtocolDef> = {
  aave: {
    displayName: "Aave",
    patterns: [
      { account: /^Liabilities:Aave:Borrow$/, category: "borrows" },
      { account: /^Income:Aave:Rewards$/, category: "rewards" },
      { currency: /^a(Eth|Arb|Opt|Bas|Pol)?[A-Z]/, category: "supplies" },
    ],
  },
  compound: {
    displayName: "Compound",
    patterns: [
      { account: /^Liabilities:Compound:Borrow$/, category: "borrows" },
      { account: /^Income:Compound:Rewards$/, category: "rewards" },
      { currency: /^c[A-Z]/, category: "supplies" },
    ],
  },
  uniswap: {
    displayName: "Uniswap",
    patterns: [
      { account: /^Income:Uniswap:Fees$/, category: "rewards" },
      { currency: /^UNI-V[23]/, category: "supplies" },
    ],
  },
  curve: {
    displayName: "Curve",
    patterns: [
      { account: /^Income:Curve:Rewards$/, category: "rewards" },
      { currency: /^crv/, category: "supplies" },
    ],
  },
  lido: {
    displayName: "Lido",
    patterns: [
      { currency: /^(st|wst)ETH$/, category: "supplies" },
    ],
  },
  pendle: {
    displayName: "Pendle",
    patterns: [
      { account: /^Income:Pendle:Rewards$/, category: "rewards" },
      { currency: /^(PT-|YT-|SY-)/, category: "supplies" },
    ],
  },
};

/**
 * Match an account against a protocol pattern by account name.
 */
function matchAccountPattern(account: Account, pattern: ProtocolPattern): boolean {
  if (pattern.account) {
    return pattern.account.test(account.full_name);
  }
  return false;
}

/**
 * Match a currency code against a protocol pattern by currency regex.
 */
function matchCurrencyPattern(currencyCode: string, pattern: ProtocolPattern): boolean {
  if (pattern.currency) {
    return pattern.currency.test(currencyCode);
  }
  return false;
}

/**
 * Compute DeFi positions by scanning all accounts and balances.
 *
 * Approach:
 * 1. List all accounts from the backend
 * 2. For each protocol, match accounts by name patterns (e.g. Liabilities:Aave:Borrow)
 * 3. Also scan asset account balances for protocol-specific token currencies
 *    (aTokens, cTokens, stETH, UNI-V2, crv*, PT-*, etc.)
 * 4. Optionally convert to base currency using exchange rates
 * 5. Group into ProtocolSummary[]
 */
export async function computeDefiPositions(
  backend: Backend,
  baseCurrency: string,
  asOf: string,
): Promise<ProtocolSummary[]> {
  const accounts = await backend.listAccounts();
  const results: Map<string, ProtocolSummary> = new Map();

  // Initialize protocol summaries
  for (const [key, def] of Object.entries(PROTOCOL_MAP)) {
    results.set(key, {
      protocol: key,
      displayName: def.displayName,
      supplies: [],
      borrows: [],
      rewards: [],
    });
  }

  // Track which account+currency combos we've already processed to avoid duplicates
  const processed = new Set<string>();

  // Phase 1: Match accounts by account name patterns
  for (const account of accounts) {
    for (const [protocolKey, def] of Object.entries(PROTOCOL_MAP)) {
      for (const pattern of def.patterns) {
        if (!pattern.account) continue;
        if (!matchAccountPattern(account, pattern)) continue;

        const balances = await backend.getAccountBalance(account.id, asOf);
        for (const bal of balances) {
          const amt = parseFloat(bal.amount);
          if (amt === 0) continue;

          const dedupKey = `${protocolKey}:${account.id}:${bal.currency}`;
          if (processed.has(dedupKey)) continue;
          processed.add(dedupKey);

          const baseValue = await convertToBase(
            backend,
            bal.currency,
            bal.amount,
            baseCurrency,
            asOf,
          );

          const position: DefiPosition = {
            protocol: protocolKey,
            action: pattern.category,
            account: account.full_name,
            currency: bal.currency,
            balance: bal.amount,
            baseValue: baseValue ?? undefined,
          };

          const summary = results.get(protocolKey)!;
          summary[pattern.category].push(position);
        }
      }
    }
  }

  // Phase 2: Scan asset accounts for protocol-specific token currencies
  const assetAccounts = accounts.filter(
    (a) => a.account_type === "asset" && !a.is_archived,
  );

  for (const account of assetAccounts) {
    const balances = await backend.getAccountBalance(account.id, asOf);

    for (const bal of balances) {
      const amt = parseFloat(bal.amount);
      if (amt === 0) continue;

      for (const [protocolKey, def] of Object.entries(PROTOCOL_MAP)) {
        for (const pattern of def.patterns) {
          if (!pattern.currency) continue;
          if (!matchCurrencyPattern(bal.currency, pattern)) continue;

          const dedupKey = `${protocolKey}:${account.id}:${bal.currency}`;
          if (processed.has(dedupKey)) continue;
          processed.add(dedupKey);

          const baseValue = await convertToBase(
            backend,
            bal.currency,
            bal.amount,
            baseCurrency,
            asOf,
          );

          const position: DefiPosition = {
            protocol: protocolKey,
            action: pattern.category,
            account: account.full_name,
            currency: bal.currency,
            balance: bal.amount,
            baseValue: baseValue ?? undefined,
          };

          const summary = results.get(protocolKey)!;
          summary[pattern.category].push(position);
        }
      }
    }
  }

  // Compute per-protocol total base value
  for (const summary of results.values()) {
    const allPositions = [
      ...summary.supplies,
      ...summary.borrows,
      ...summary.rewards,
    ];
    if (allPositions.length > 0 && allPositions.every((p) => p.baseValue !== undefined)) {
      let total = 0;
      for (const p of allPositions) {
        const val = parseFloat(p.baseValue!);
        // Borrows are liabilities; treat as negative for total
        if (p.action === "borrows") {
          total -= Math.abs(val);
        } else {
          total += val;
        }
      }
      summary.totalBaseValue = total.toFixed(2);
    }
  }

  // Return only protocols with at least one position, sorted by displayName
  return Array.from(results.values())
    .filter(
      (s) =>
        s.supplies.length > 0 ||
        s.borrows.length > 0 ||
        s.rewards.length > 0,
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Convert an amount in a given currency to the base currency.
 * Returns null if no exchange rate is available.
 */
async function convertToBase(
  backend: Backend,
  currency: string,
  amount: string,
  baseCurrency: string,
  asOf: string,
): Promise<string | null> {
  if (currency === baseCurrency) {
    return parseFloat(amount).toFixed(2);
  }
  const rateStr = await backend.getExchangeRate(currency, baseCurrency, asOf);
  if (!rateStr) return null;
  const rate = parseFloat(rateStr);
  const converted = parseFloat(amount) * rate;
  return converted.toFixed(2);
}
