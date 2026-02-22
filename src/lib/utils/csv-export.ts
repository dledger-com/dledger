import type {
  TrialBalance,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
  UnrealizedGainLossReport,
  UnrealizedGainLossLine,
} from "$lib/types/index.js";
import type { TaxSummary } from "./tax-summary.js";
import type { PortfolioReport } from "./portfolio.js";
import type { FrenchTaxReport } from "./french-tax.js";
import { SUPPORTED_CHAINS } from "$lib/types/index.js";

function escapeCsv(value: string | number): string {
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields: (string | number)[]): string {
  return fields.map(escapeCsv).join(",");
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportTrialBalanceCsv(report: TrialBalance): void {
  const rows: string[] = [toCsvRow(["Account", "Type", "Currency", "Debit", "Credit"])];

  for (const line of report.lines) {
    for (const b of line.balances) {
      const amount = parseFloat(b.amount);
      rows.push(
        toCsvRow([
          line.account_name,
          line.account_type,
          b.currency,
          amount > 0 ? b.amount : "",
          amount < 0 ? String(Math.abs(amount)) : "",
        ]),
      );
    }
  }

  downloadCsv(`trial-balance-${report.as_of}.csv`, rows.join("\n"));
}

export function exportIncomeStatementCsv(report: IncomeStatement): void {
  const rows: string[] = [toCsvRow(["Section", "Account", "Currency", "Amount"])];

  for (const section of [report.revenue, report.expenses]) {
    for (const line of section.lines) {
      for (const b of line.balances) {
        rows.push(
          toCsvRow([section.title, line.account_name, b.currency, Math.abs(parseFloat(b.amount))]),
        );
      }
    }
    for (const b of section.totals) {
      rows.push(toCsvRow([`Total ${section.title}`, "", b.currency, Math.abs(parseFloat(b.amount))]));
    }
  }

  for (const b of report.net_income) {
    rows.push(toCsvRow(["Net Income", "", b.currency, b.amount]));
  }

  downloadCsv(`income-statement-${report.from_date}-to-${report.to_date}.csv`, rows.join("\n"));
}

export function exportBalanceSheetCsv(report: BalanceSheet): void {
  const rows: string[] = [toCsvRow(["Section", "Account", "Currency", "Balance"])];

  for (const section of [report.assets, report.liabilities, report.equity]) {
    for (const line of section.lines) {
      for (const b of line.balances) {
        rows.push(toCsvRow([section.title, line.account_name, b.currency, b.amount]));
      }
    }
    for (const b of section.totals) {
      rows.push(toCsvRow([`Total ${section.title}`, "", b.currency, b.amount]));
    }
  }

  downloadCsv(`balance-sheet-${report.as_of}.csv`, rows.join("\n"));
}

export function exportGainLossCsv(report: GainLossReport): void {
  const rows: string[] = [
    toCsvRow(["Currency", "Acquired", "Disposed", "Quantity", "Cost Basis", "Proceeds", "Gain/Loss", "Protocol"]),
  ];

  for (const line of report.lines) {
    rows.push(
      toCsvRow([
        line.currency,
        line.acquired_date,
        line.disposed_date,
        line.quantity,
        line.cost_basis,
        line.proceeds,
        line.gain_loss,
        line.source_handler || "",
      ]),
    );
  }

  downloadCsv(`gain-loss-${report.from_date}-to-${report.to_date}.csv`, rows.join("\n"));
}

export function exportUnrealizedGainLossCsv(report: UnrealizedGainLossReport): void {
  const rows: string[] = [
    toCsvRow([
      "Currency",
      "Account",
      "Acquired",
      "Quantity",
      "Cost Basis/Unit",
      "Cost Currency",
      "Current Value",
      "Unrealized Gain/Loss",
      "Protocol",
    ]),
  ];

  for (const line of report.lines) {
    rows.push(
      toCsvRow([
        line.currency,
        line.account_name,
        line.acquired_date,
        line.quantity,
        line.cost_basis_per_unit,
        line.cost_basis_currency,
        line.current_value,
        line.unrealized_gain_loss,
        line.source_handler || "",
      ]),
    );
  }

  downloadCsv(`unrealized-gain-loss-${report.as_of}.csv`, rows.join("\n"));
}

export function exportTaxSummaryCsv(summary: TaxSummary): void {
  const rows: string[] = [];

  // Summary section
  rows.push(toCsvRow(["Tax Summary", `${summary.from_date} to ${summary.to_date}`]));
  rows.push(toCsvRow(["Holding Period (days)", summary.holding_period_days]));
  rows.push("");
  rows.push(toCsvRow(["Category", "Amount"]));
  rows.push(toCsvRow(["Short-Term Gains", summary.short_term_gains]));
  rows.push(toCsvRow(["Short-Term Losses", summary.short_term_losses]));
  rows.push(toCsvRow(["Long-Term Gains", summary.long_term_gains]));
  rows.push(toCsvRow(["Long-Term Losses", summary.long_term_losses]));
  rows.push(toCsvRow(["Total Realized", summary.total_realized]));
  rows.push(toCsvRow(["Total Unrealized", summary.total_unrealized]));
  rows.push("");

  // Gain/Loss detail lines
  rows.push(toCsvRow(["Gain/Loss Details"]));
  rows.push(
    toCsvRow(["Classification", "Currency", "Acquired", "Disposed", "Quantity", "Cost Basis", "Proceeds", "Gain/Loss", "Protocol"]),
  );
  for (const line of summary.gain_loss_lines) {
    rows.push(
      toCsvRow([
        line.is_long_term ? "Long-Term" : "Short-Term",
        line.currency,
        line.acquired_date,
        line.disposed_date,
        line.quantity,
        line.cost_basis,
        line.proceeds,
        line.gain_loss,
        line.source_handler || "",
      ]),
    );
  }
  rows.push("");

  // Income by account
  rows.push(toCsvRow(["Income by Account"]));
  rows.push(toCsvRow(["Account", "Currency", "Amount"]));
  for (const inc of summary.income_by_account) {
    rows.push(toCsvRow([inc.account_name, inc.currency, inc.amount]));
  }

  downloadCsv(`tax-summary-${summary.from_date}-to-${summary.to_date}.csv`, rows.join("\n"));
}

export function exportPortfolioCsv(report: PortfolioReport): void {
  const rows: string[] = [toCsvRow(["Wallet", "Address", "Chain", "Currency", "Amount", "Base Value"])];

  for (const wallet of report.wallets) {
    const chain = SUPPORTED_CHAINS.find((c) => c.chain_id === wallet.chainId);
    const chainLabel = chain ? chain.name : `Chain ${wallet.chainId}`;

    for (const holding of wallet.holdings) {
      rows.push(
        toCsvRow([
          wallet.label,
          wallet.address,
          chainLabel,
          holding.currency,
          holding.amount,
          holding.baseValue ?? "",
        ]),
      );
    }

    // Total row per wallet
    rows.push(
      toCsvRow([
        wallet.label,
        wallet.address,
        chainLabel,
        "TOTAL",
        "",
        wallet.totalBaseValue ?? "",
      ]),
    );
  }

  downloadCsv(`portfolio-${report.as_of}.csv`, rows.join("\n"));
}

export function exportFrenchTaxCsv(report: FrenchTaxReport): void {
  const rows: string[] = [];

  // Summary section
  rows.push(toCsvRow(["French Crypto Tax Report (Art. 150 VH bis)", `Year ${report.taxYear}`]));
  rows.push(toCsvRow(["Total Plus-Value", report.totalPlusValue]));
  rows.push(toCsvRow(["Total Fiat Received", report.totalFiatReceived]));
  rows.push(toCsvRow(["Final Acquisition Cost (A)", report.finalAcquisitionCost]));
  rows.push(toCsvRow(["Year-End Portfolio Value (V)", report.yearEndPortfolioValue]));
  rows.push(toCsvRow(["Box 3AN (Plus-Value)", report.box3AN]));
  rows.push(toCsvRow(["Box 3BN (Moins-Value)", report.box3BN]));
  rows.push(toCsvRow(["Exempt (<=305 EUR)", report.isExempt ? "Yes" : "No"]));
  rows.push(toCsvRow(["Tax at PFU 30%", report.taxDuePFU30]));
  rows.push(toCsvRow(["Tax at PFU 31.4%", report.taxDuePFU314]));
  rows.push("");

  // Disposition detail rows (Form 2086 fields)
  rows.push(toCsvRow(["Dispositions (Form 2086)"]));
  rows.push(
    toCsvRow(["#", "Date", "Description", "Crypto", "Fiat Received (C)", "Portfolio Value (V)",
      "Acq. Cost (A)", "Fraction (A*C/V)", "Plus-Value"]),
  );
  for (let i = 0; i < report.dispositions.length; i++) {
    const d = report.dispositions[i];
    rows.push(
      toCsvRow([
        i + 1, d.date, d.description, d.cryptoCurrencies.join("+"),
        d.fiatReceived, d.portfolioValue, d.acquisitionCostBefore,
        d.costFraction, d.plusValue,
      ]),
    );
  }
  rows.push("");

  // Acquisition reference rows
  rows.push(toCsvRow(["Acquisitions"]));
  rows.push(toCsvRow(["Date", "Description", "Fiat Spent (EUR)", "Crypto"]));
  for (const a of report.acquisitions) {
    rows.push(toCsvRow([a.date, a.description, a.fiatSpent, a.cryptoCurrencies.join("+")]));
  }

  downloadCsv(`french-tax-${report.taxYear}.csv`, rows.join("\n"));
}
