import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DOM elements for downloadCsv
let lastDownloadedContent = "";

vi.stubGlobal("URL", {
  createObjectURL: () => "blob:test",
  revokeObjectURL: () => {},
});

// Mock document.createElement
const mockLink = { href: "", download: "", click: vi.fn() };
vi.stubGlobal("document", {
  createElement: () => mockLink,
});
vi.stubGlobal(
  "Blob",
  class {
    content: string[];
    constructor(parts: string[]) {
      this.content = parts;
      lastDownloadedContent = parts.join("");
    }
  },
);

// Now import the module
import {
  exportTrialBalanceCsv,
  exportIncomeStatementCsv,
  exportBalanceSheetCsv,
  exportGainLossCsv,
} from "./csv-export.js";

import type {
  TrialBalance,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
} from "$lib/types/index.js";

describe("csv-export", () => {
  beforeEach(() => {
    lastDownloadedContent = "";
    mockLink.click.mockClear();
  });

  it("exports trial balance CSV", () => {
    const report: TrialBalance = {
      as_of: "2024-01-31",
      lines: [
        {
          account_id: "1",
          account_name: "Assets:Bank",
          account_type: "asset",
          balances: [{ currency: "USD", amount: "1000" }],
        },
      ],
      total_debits: [{ currency: "USD", amount: "1000" }],
      total_credits: [{ currency: "USD", amount: "0" }],
    };

    exportTrialBalanceCsv(report);
    expect(lastDownloadedContent).toContain("Account,Type,Currency,Debit,Credit");
    expect(lastDownloadedContent).toContain("Assets:Bank,asset,USD,1000,");
    expect(mockLink.download).toContain("trial-balance");
  });

  it("exports balance sheet CSV with sections", () => {
    const report: BalanceSheet = {
      as_of: "2024-01-31",
      assets: {
        title: "Assets",
        account_type: "asset",
        lines: [
          {
            account_id: "1",
            account_name: "Assets:Bank",
            account_type: "asset",
            balances: [{ currency: "USD", amount: "1000" }],
          },
        ],
        totals: [{ currency: "USD", amount: "1000" }],
      },
      liabilities: {
        title: "Liabilities",
        account_type: "liability",
        lines: [],
        totals: [{ currency: "USD", amount: "0" }],
      },
      equity: {
        title: "Equity",
        account_type: "equity",
        lines: [
          {
            account_id: "2",
            account_name: "Equity:Opening",
            account_type: "equity",
            balances: [{ currency: "USD", amount: "-1000" }],
          },
        ],
        totals: [{ currency: "USD", amount: "-1000" }],
      },
    };

    exportBalanceSheetCsv(report);
    expect(lastDownloadedContent).toContain("Section,Account,Currency,Balance");
    expect(lastDownloadedContent).toContain("Assets,Assets:Bank,USD,1000");
    expect(lastDownloadedContent).toContain("Total Assets,,USD,1000");
  });

  it("escapes CSV fields with commas and quotes", () => {
    const report: TrialBalance = {
      as_of: "2024-01-31",
      lines: [
        {
          account_id: "1",
          account_name: 'Assets:Bank "Main"',
          account_type: "asset",
          balances: [{ currency: "USD", amount: "1000" }],
        },
      ],
      total_debits: [{ currency: "USD", amount: "1000" }],
      total_credits: [{ currency: "USD", amount: "0" }],
    };

    exportTrialBalanceCsv(report);
    // The account name with quotes should be escaped
    expect(lastDownloadedContent).toContain('"Assets:Bank ""Main"""');
  });

  it("exports income statement CSV", () => {
    const report: IncomeStatement = {
      from_date: "2024-01-01",
      to_date: "2024-01-31",
      revenue: {
        title: "Revenue",
        account_type: "revenue",
        lines: [
          {
            account_id: "1",
            account_name: "Income:Salary",
            account_type: "revenue",
            balances: [{ currency: "USD", amount: "-3000" }],
          },
        ],
        totals: [{ currency: "USD", amount: "-3000" }],
      },
      expenses: {
        title: "Expenses",
        account_type: "expense",
        lines: [
          {
            account_id: "2",
            account_name: "Expenses:Food",
            account_type: "expense",
            balances: [{ currency: "USD", amount: "50" }],
          },
        ],
        totals: [{ currency: "USD", amount: "50" }],
      },
      net_income: [{ currency: "USD", amount: "2950" }],
    };

    exportIncomeStatementCsv(report);
    expect(lastDownloadedContent).toContain("Section,Account,Currency,Amount");
    expect(lastDownloadedContent).toContain("Revenue,Income:Salary,USD,3000");
    expect(lastDownloadedContent).toContain("Expenses,Expenses:Food,USD,50");
    expect(lastDownloadedContent).toContain("Net Income,,USD,2950");
  });

  it("exports gain/loss CSV", () => {
    const report: GainLossReport = {
      from_date: "2024-01-01",
      to_date: "2024-12-31",
      lines: [
        {
          lot_id: "lot-1",
          currency: "ETH",
          acquired_date: "2024-01-01",
          disposed_date: "2024-06-01",
          quantity: "1",
          cost_basis: "2000",
          proceeds: "3000",
          gain_loss: "1000",
          source_handler: "uniswap",
        },
      ],
      total_gain_loss: "1000",
    };

    exportGainLossCsv(report);
    expect(lastDownloadedContent).toContain("Currency,Acquired,Disposed");
    expect(lastDownloadedContent).toContain("ETH,2024-01-01,2024-06-01");
    expect(lastDownloadedContent).toContain("uniswap");
  });
});
