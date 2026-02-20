import type { Backend } from "$lib/backend.js";
import type {
  OpenLot,
  UnrealizedGainLossLine,
  UnrealizedGainLossReport,
} from "$lib/types/index.js";

export interface UnrealizedGainLossOptions {
  baseCurrency: string;
  asOfDate: string;
}

export async function computeUnrealizedGainLoss(
  backend: Backend,
  opts: UnrealizedGainLossOptions,
): Promise<{ report: UnrealizedGainLossReport; missingRates: string[] }> {
  const lots = await backend.listOpenLots();
  const lines: UnrealizedGainLossLine[] = [];
  const missingRates: string[] = [];
  let totalUnrealized = 0;

  // Group by currency to batch rate lookups
  const byCurrency = new Map<string, OpenLot[]>();
  for (const lot of lots) {
    let list = byCurrency.get(lot.currency);
    if (!list) {
      list = [];
      byCurrency.set(lot.currency, list);
    }
    list.push(lot);
  }

  for (const [currency, currencyLots] of byCurrency) {
    // Get current rate: currency → base
    let rate: number | null = null;
    if (currency === opts.baseCurrency) {
      rate = 1;
    } else {
      const rateStr = await backend.getExchangeRate(currency, opts.baseCurrency, opts.asOfDate);
      if (rateStr) {
        rate = parseFloat(rateStr);
      } else {
        missingRates.push(currency);
      }
    }

    for (const lot of currencyLots) {
      const qty = parseFloat(lot.remaining_quantity);
      const costPerUnit = parseFloat(lot.cost_basis_per_unit);

      // Cost basis in cost_basis_currency
      const totalCostBasis = qty * costPerUnit;

      // Convert cost basis to base currency if needed
      let costBasisInBase: number;
      if (lot.cost_basis_currency === opts.baseCurrency) {
        costBasisInBase = totalCostBasis;
      } else {
        const costRateStr = await backend.getExchangeRate(
          lot.cost_basis_currency,
          opts.baseCurrency,
          opts.asOfDate,
        );
        if (costRateStr) {
          costBasisInBase = totalCostBasis * parseFloat(costRateStr);
        } else {
          // Use cost basis as-is if no rate available
          costBasisInBase = totalCostBasis;
          if (!missingRates.includes(lot.cost_basis_currency)) {
            missingRates.push(lot.cost_basis_currency);
          }
        }
      }

      // Current value in base currency
      let currentValueInBase: number;
      if (rate !== null) {
        currentValueInBase = qty * rate;
      } else {
        // Can't compute without rate
        currentValueInBase = 0;
      }

      const unrealizedGL = currentValueInBase - costBasisInBase;
      totalUnrealized += unrealizedGL;

      lines.push({
        currency,
        account_name: lot.account_name,
        acquired_date: lot.acquired_date,
        quantity: lot.remaining_quantity,
        cost_basis_per_unit: lot.cost_basis_per_unit,
        cost_basis_currency: lot.cost_basis_currency,
        current_value: currentValueInBase.toFixed(2),
        unrealized_gain_loss: unrealizedGL.toFixed(2),
        source_handler: lot.source_handler ?? null,
      });
    }
  }

  return {
    report: {
      as_of: opts.asOfDate,
      lines,
      total_unrealized: totalUnrealized.toFixed(2),
      base_currency: opts.baseCurrency,
    },
    missingRates,
  };
}
