import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { CurrencyBalance } from "$lib/types/index.js";

// We need to mock getBackend since convertBalances uses it directly.
// Instead, we test the logic by calling the backend ourselves and verifying behavior.
import { seedBasicLedger } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

// Manual implementation of convertBalances logic for testing
// (the real one uses getBackend() singleton which is hard to mock)
async function convertBalancesWithBackend(
  backend: SqlJsBackend,
  balances: CurrencyBalance[],
  baseCurrency: string,
  asOfDate: string,
) {
  let total = 0;
  const converted: { currency: string; amount: number; rate: number; baseAmount: number }[] = [];
  const unconverted: { currency: string; amount: number }[] = [];

  for (const b of balances) {
    const amount = parseFloat(b.amount);
    if (b.currency === baseCurrency) {
      total += amount;
      converted.push({ currency: b.currency, amount, rate: 1, baseAmount: amount });
      continue;
    }
    const rateStr = await backend.getExchangeRate(b.currency, baseCurrency, asOfDate);
    if (rateStr) {
      const rate = parseFloat(rateStr);
      const baseAmount = amount * rate;
      total += baseAmount;
      converted.push({ currency: b.currency, amount, rate, baseAmount });
    } else {
      unconverted.push({ currency: b.currency, amount });
    }
  }

  return { total, baseCurrency, converted, unconverted };
}

describe("currency conversion logic", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    const seeded = await seedBasicLedger();
    backend = seeded.backend;
  });

  it("converts base currency at rate 1", async () => {
    const balances: CurrencyBalance[] = [{ currency: "USD", amount: "1000" }];
    const result = await convertBalancesWithBackend(backend, balances, "USD", "2024-12-31");
    expect(result.total).toBe(1000);
    expect(result.converted).toHaveLength(1);
    expect(result.converted[0].rate).toBe(1);
    expect(result.unconverted).toHaveLength(0);
  });

  it("converts foreign currency with available rate", async () => {
    await backend.recordExchangeRate({
      id: uuidv7(), date: "2024-01-01",
      from_currency: "EUR", to_currency: "USD",
      rate: "1.10", source: "manual",
    });

    const balances: CurrencyBalance[] = [
      { currency: "USD", amount: "500" },
      { currency: "EUR", amount: "100" },
    ];
    const result = await convertBalancesWithBackend(backend, balances, "USD", "2024-01-01");
    expect(result.total).toBeCloseTo(610, 2); // 500 + 100*1.10
    expect(result.converted).toHaveLength(2);
    expect(result.unconverted).toHaveLength(0);
  });

  it("puts currency without rate into unconverted", async () => {
    const balances: CurrencyBalance[] = [
      { currency: "USD", amount: "500" },
      { currency: "EUR", amount: "100" },
    ];
    const result = await convertBalancesWithBackend(backend, balances, "USD", "2024-01-01");
    expect(result.total).toBe(500); // Only USD counted
    expect(result.converted).toHaveLength(1);
    expect(result.unconverted).toHaveLength(1);
    expect(result.unconverted[0].currency).toBe("EUR");
  });

  it("handles empty balances", async () => {
    const result = await convertBalancesWithBackend(backend, [], "USD", "2024-01-01");
    expect(result.total).toBe(0);
    expect(result.converted).toHaveLength(0);
    expect(result.unconverted).toHaveLength(0);
  });
});
