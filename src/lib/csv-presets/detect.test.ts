import { describe, it, expect } from "vitest";
import { detectColumns } from "./detect.js";
import { bittrexPreset } from "./presets/bittrex.js";
import { cryptoComExchangePreset } from "./presets/crypto-com-exchange.js";
import { yieldAppPreset } from "./presets/yield-app.js";
import { kucoinPreset } from "./presets/kucoin.js";

describe("detectColumns", () => {
  it("detects standard bank statement columns by header name", () => {
    const headers = ["Date", "Description", "Amount", "Balance"];
    const rows = [
      ["2024-01-15", "Coffee shop", "5.00", "1000.00"],
      ["2024-01-16", "Grocery", "25.00", "975.00"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.dateColumn).toBe("Date");
    expect(result.descriptionColumn).toBe("Description");
    expect(result.amountColumn).toBe("Amount");
    expect(result.balanceColumn).toBe("Balance");
    expect(result.amountMode).toBe("single");
  });

  it("detects debit/credit split columns", () => {
    const headers = ["date", "memo", "debit", "credit", "balance"];
    const rows = [
      ["2024-01-15", "Coffee", "5.00", "", "1000.00"],
      ["2024-01-16", "Salary", "", "3000.00", "4000.00"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.dateColumn).toBe("date");
    expect(result.debitAmountColumn).toBe("debit");
    expect(result.creditAmountColumn).toBe("credit");
    expect(result.amountMode).toBe("split");
  });

  it("detects date format from values", () => {
    const headers = ["Date", "Amount"];
    const rows = [
      ["15.01.2024", "100"],
      ["20.02.2024", "200"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.dateFormat).toBe("DD.MM.YYYY");
  });

  it("detects currency column by header name", () => {
    const headers = ["Date", "Amount", "Currency"];
    const rows = [
      ["2024-01-15", "100", "EUR"],
      ["2024-01-16", "200", "USD"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.currencyColumn).toBe("Currency");
  });

  it("detects currency column by value sniffing", () => {
    const headers = ["Date", "Amount", "Ccy"];
    const rows = [
      ["2024-01-15", "100", "EUR"],
      ["2024-01-16", "200", "USD"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.currencyColumn).toBe("Ccy");
  });

  it("handles empty headers", () => {
    const result = detectColumns([], []);
    expect(result.dateColumn).toBeNull();
    expect(result.amountMode).toBe("unknown");
  });

  it("sniffs date column from values when header doesn't match", () => {
    const headers = ["col_a", "col_b"];
    const rows = [
      ["2024-01-15", "100"],
      ["2024-01-16", "200"],
      ["2024-01-17", "300"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.dateColumn).toBe("col_a");
  });

  it("sniffs numeric column for amount when header doesn't match", () => {
    const headers = ["Date", "val"];
    const rows = [
      ["2024-01-15", "100.50"],
      ["2024-01-16", "200.75"],
      ["2024-01-17", "300.00"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.amountColumn).toBe("val");
  });

  it("detects European number format", () => {
    const headers = ["Date", "Amount"];
    const rows = [
      ["2024-01-15", "1.234,56"],
      ["2024-01-16", "2.345,67"],
      ["2024-01-17", "100,00"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.europeanNumbers).toBe(true);
  });

  it("uses transaction_date as date column", () => {
    const headers = ["transaction_date", "description", "amount"];
    const rows = [["2024-01-15", "test", "100"]];

    const result = detectColumns(headers, rows);
    expect(result.dateColumn).toBe("transaction_date");
  });

  it("promotes single debit column to amountColumn", () => {
    const headers = ["date", "memo", "debit"];
    const rows = [["2024-01-15", "Coffee", "5.00"]];

    const result = detectColumns(headers, rows);
    expect(result.amountColumn).toBe("debit");
    expect(result.amountMode).toBe("single");
    expect(result.debitAmountColumn).toBeNull();
  });

  it("detects ISO8601 date format", () => {
    const headers = ["Date", "Amount"];
    const rows = [
      ["2024-01-15T10:30:00Z", "100"],
      ["2024-01-16T14:00:00Z", "200"],
    ];

    const result = detectColumns(headers, rows);
    expect(result.dateFormat).toBe("ISO8601");
  });
});

describe("cross-preset detection", () => {
  it("Gate.io deposit/withdrawal headers are not detected as Bittrex or Crypto.com Exchange", () => {
    const depositHeaders = ["id", "txid", "withdraw_order_id", "timestamp", "amount", "currency", "address", "memo", "status", "chain"];
    const withdrawalHeaders = ["id", "txid", "block_number", "withdraw_order_id", "timestamp", "amount", "fee", "currency", "address", "fail_reason", "timestamp2", "memo", "status", "chain", "type"];
    expect(bittrexPreset.detect(depositHeaders, [])).toBe(0);
    expect(bittrexPreset.detect(withdrawalHeaders, [])).toBe(0);
    expect(cryptoComExchangePreset.detect(depositHeaders, [])).toBe(0);
    expect(cryptoComExchangePreset.detect(withdrawalHeaders, [])).toBe(0);
  });

  it("KuCoin headers return 0 from other exchange presets", () => {
    const kucoinSpotHeaders = [
      "UID", "Account Type", "Order ID", "Symbol", "Side", "Order Type",
      "Avg. Filled Price", "Filled Amount", "Filled Volume",
      "Filled Volume (USDT)", "Filled Time(UTC+02:00)", "Fee", "Maker/Taker",
      "Fee Currency", "Tax",
    ];
    const kucoinDepositHeaders = [
      "UID", "Account Type", "Time(UTC+02:00)", "Remarks", "Status", "Fee",
      "Amount", "Coin", "Transfer Network",
    ];
    expect(bittrexPreset.detect(kucoinSpotHeaders, [])).toBe(0);
    expect(cryptoComExchangePreset.detect(kucoinSpotHeaders, [])).toBe(0);
    expect(bittrexPreset.detect(kucoinDepositHeaders, [])).toBe(0);
    expect(cryptoComExchangePreset.detect(kucoinDepositHeaders, [])).toBe(0);
  });

  it("Yield App headers are not detected as Bittrex or Crypto.com Exchange", () => {
    const yieldAppHeaders = ["Date", "Amount", "Currency", "Type", "Status", "Rewarded From", "Fund Price", "YLD Price", "Txid", "Address From", "Address To"];
    expect(bittrexPreset.detect(yieldAppHeaders, [])).toBe(0);
    expect(cryptoComExchangePreset.detect(yieldAppHeaders, [])).toBeLessThan(yieldAppPreset.detect(yieldAppHeaders, []));
    expect(yieldAppPreset.detect(yieldAppHeaders, [])).toBe(90);
  });
});
