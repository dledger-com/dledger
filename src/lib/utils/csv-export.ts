import type {
  TrialBalance,
  IncomeStatement,
  BalanceSheet,
  GainLossReport,
  UnrealizedGainLossReport,
  UnrealizedGainLossLine,
} from "$lib/types/index.js";

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
    toCsvRow(["Currency", "Acquired", "Disposed", "Quantity", "Cost Basis", "Proceeds", "Gain/Loss"]),
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
      ]),
    );
  }

  downloadCsv(`unrealized-gain-loss-${report.as_of}.csv`, rows.join("\n"));
}
