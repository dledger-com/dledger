import { describe, it, expect } from "vitest";
import { pairLineItems, classifyFlow, type Flow } from "./flow-pairing.js";
import type { LineItem } from "$lib/types/index.js";
import type { AccountType } from "$lib/types/account.js";

function li(
  accountId: string,
  currency: string,
  amount: string,
): LineItem {
  return {
    id: `li-${accountId}-${amount}`,
    journal_entry_id: "e1",
    account_id: accountId,
    currency,
    amount,
    lot_id: null,
  };
}

const typeLookup: Record<string, AccountType> = {
  bank: "asset",
  cash: "asset",
  wallet: "asset",
  rent: "expense",
  food: "expense",
  salary: "revenue",
  loan: "liability",
  opening: "equity",
};

function lookup(id: string): AccountType | undefined {
  return typeLookup[id];
}

describe("classifyFlow", () => {
  it("revenue → asset = income", () => {
    expect(classifyFlow("revenue", "asset")).toBe("income");
  });

  it("asset → expense = expense", () => {
    expect(classifyFlow("asset", "expense")).toBe("expense");
  });

  it("asset → asset = transfer", () => {
    expect(classifyFlow("asset", "asset")).toBe("transfer");
  });

  it("asset → liability = transfer", () => {
    expect(classifyFlow("asset", "liability")).toBe("transfer");
  });

  it("liability → asset = transfer", () => {
    expect(classifyFlow("liability", "asset")).toBe("transfer");
  });

  it("anything with equity = equity", () => {
    expect(classifyFlow("equity", "asset")).toBe("equity");
    expect(classifyFlow("asset", "equity")).toBe("equity");
  });

  it("unknown types = mixed", () => {
    expect(classifyFlow(undefined, "asset")).toBe("mixed");
    expect(classifyFlow("expense", "revenue")).toBe("mixed");
  });
});

describe("pairLineItems", () => {
  it("pairs simple 2-line entry", () => {
    const items = [
      li("rent", "EUR", "500"),    // debit: expense
      li("bank", "EUR", "-500"),   // credit: asset
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows).toHaveLength(1);
    expect(flows[0].sourceAccountId).toBe("bank");
    expect(flows[0].destAccountId).toBe("rent");
    expect(flows[0].amount).toBe("500");
    expect(flows[0].currency).toBe("EUR");
    expect(flows[0].flowType).toBe("expense");
  });

  it("handles multi-currency entries independently", () => {
    const items = [
      li("rent", "EUR", "500"),
      li("bank", "EUR", "-500"),
      li("food", "USD", "20"),
      li("cash", "USD", "-20"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows).toHaveLength(2);

    const eurFlow = flows.find((f) => f.currency === "EUR")!;
    expect(eurFlow.sourceAccountId).toBe("bank");
    expect(eurFlow.destAccountId).toBe("rent");

    const usdFlow = flows.find((f) => f.currency === "USD")!;
    expect(usdFlow.sourceAccountId).toBe("cash");
    expect(usdFlow.destAccountId).toBe("food");
  });

  it("handles N:1 split (one credit, multiple debits)", () => {
    const items = [
      li("rent", "EUR", "300"),
      li("food", "EUR", "200"),
      li("bank", "EUR", "-500"),
    ];
    const flows = pairLineItems(items, lookup);
    // Should produce 2 flows: bank→rent(300), bank→food(200)
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => f.sourceAccountId === "bank")).toBe(true);
    const amounts = flows.map((f) => parseFloat(f.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([200, 300]);
  });

  it("handles 1:N split (one debit, multiple credits)", () => {
    const items = [
      li("bank", "EUR", "500"),
      li("salary", "EUR", "-300"),
      li("opening", "EUR", "-200"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows).toHaveLength(2);
    expect(flows.every((f) => f.destAccountId === "bank")).toBe(true);
    const amounts = flows.map((f) => parseFloat(f.amount)).sort((a, b) => a - b);
    expect(amounts).toEqual([200, 300]);
  });

  it("prioritizes exact matches", () => {
    // bank(-300), cash(-200) credits; rent(300), food(200) debits
    // Exact match should pair bank↔rent(300) and cash↔food(200)
    const items = [
      li("rent", "EUR", "300"),
      li("food", "EUR", "200"),
      li("bank", "EUR", "-300"),
      li("cash", "EUR", "-200"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows).toHaveLength(2);

    const rentFlow = flows.find((f) => f.destAccountId === "rent")!;
    expect(rentFlow.sourceAccountId).toBe("bank");
    expect(rentFlow.amount).toBe("300");

    const foodFlow = flows.find((f) => f.destAccountId === "food")!;
    expect(foodFlow.sourceAccountId).toBe("cash");
    expect(foodFlow.amount).toBe("200");
  });

  it("skips zero-amount items", () => {
    const items = [
      li("rent", "EUR", "500"),
      li("bank", "EUR", "-500"),
      li("food", "EUR", "0"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(pairLineItems([], lookup)).toEqual([]);
  });

  it("classifies income flow correctly", () => {
    const items = [
      li("bank", "EUR", "3000"),
      li("salary", "EUR", "-3000"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows[0].flowType).toBe("income");
  });

  it("classifies transfer flow correctly", () => {
    const items = [
      li("wallet", "EUR", "100"),
      li("bank", "EUR", "-100"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows[0].flowType).toBe("transfer");
  });

  it("classifies equity flow correctly", () => {
    const items = [
      li("bank", "EUR", "1000"),
      li("opening", "EUR", "-1000"),
    ];
    const flows = pairLineItems(items, lookup);
    expect(flows[0].flowType).toBe("equity");
  });
});
