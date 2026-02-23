import type { Backend } from "$lib/backend.js";
import type { EtherscanAccount } from "$lib/types/index.js";
import { ExchangeRateCache } from "./exchange-rate-cache.js";

export interface WalletHolding {
  currency: string;
  amount: string;
  baseValue: string | null; // converted to base currency, null if no rate
}

export interface WalletSummary {
  label: string;
  address: string;
  chainId: number;
  holdings: WalletHolding[];
  totalBaseValue: string | null; // sum of converted holdings, null if any missing
}

export interface PortfolioReport {
  as_of: string;
  base_currency: string;
  wallets: WalletSummary[];
  aggregate_total: string | null;
  missingCurrencies: string[];
}

export async function computePortfolioReport(
  backend: Backend,
  baseCurrency: string,
  asOf: string,
  hiddenCurrencies?: Set<string>,
): Promise<PortfolioReport> {
  const ethAccounts = await backend.listEtherscanAccounts();
  const accounts = await backend.listAccounts();
  const cache = new ExchangeRateCache(backend);

  const wallets: WalletSummary[] = [];
  const missingCurrencySet = new Set<string>();

  // Group etherscan accounts by label
  const byLabel = new Map<string, EtherscanAccount[]>();
  for (const ea of ethAccounts) {
    const existing = byLabel.get(ea.label) ?? [];
    existing.push(ea);
    byLabel.set(ea.label, existing);
  }

  for (const [label, ethAccts] of byLabel) {
    for (const ea of ethAccts) {
      // Find matching Assets:*:{label} accounts
      const matchingAccounts = accounts.filter(
        (a) =>
          a.account_type === "asset" &&
          a.full_name.includes(`:${label}`) &&
          !a.is_archived,
      );

      const allHoldings: WalletHolding[] = [];
      const seenCurrencies = new Set<string>();

      for (const acc of matchingAccounts) {
        const balances = await backend.getAccountBalanceWithChildren(
          acc.id,
          asOf,
        );
        for (const bal of balances) {
          if (seenCurrencies.has(bal.currency)) continue;
          if (hiddenCurrencies?.has(bal.currency)) continue;
          seenCurrencies.add(bal.currency);

          const amount = parseFloat(bal.amount);
          if (Math.abs(amount) < 1e-10) continue;

          let baseValue: string | null = null;
          if (bal.currency === baseCurrency) {
            baseValue = amount.toFixed(2);
          } else {
            const rate = await cache.get(bal.currency, baseCurrency, asOf);
            if (rate) {
              baseValue = (amount * parseFloat(rate)).toFixed(2);
            } else {
              missingCurrencySet.add(bal.currency);
            }
          }

          allHoldings.push({
            currency: bal.currency,
            amount: bal.amount,
            baseValue,
          });
        }
      }

      // Compute total
      let totalBaseValue: string | null = null;
      if (allHoldings.length > 0) {
        const allConverted = allHoldings.every((h) => h.baseValue !== null);
        if (allConverted) {
          const total = allHoldings.reduce(
            (sum, h) => sum + parseFloat(h.baseValue!),
            0,
          );
          totalBaseValue = total.toFixed(2);
        }
      }

      if (allHoldings.length > 0) {
        wallets.push({
          label,
          address: ea.address,
          chainId: ea.chain_id,
          holdings: allHoldings.sort((a, b) =>
            a.currency.localeCompare(b.currency),
          ),
          totalBaseValue,
        });
      }
    }
  }

  // Aggregate total
  let aggregateTotal: string | null = null;
  if (
    wallets.length > 0 &&
    wallets.every((w) => w.totalBaseValue !== null)
  ) {
    const total = wallets.reduce(
      (sum, w) => sum + parseFloat(w.totalBaseValue!),
      0,
    );
    aggregateTotal = total.toFixed(2);
  }

  return {
    as_of: asOf,
    base_currency: baseCurrency,
    wallets: wallets.sort((a, b) => a.label.localeCompare(b.label)),
    aggregate_total: aggregateTotal,
    missingCurrencies: [...missingCurrencySet],
  };
}
