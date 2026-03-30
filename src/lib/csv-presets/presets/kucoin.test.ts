import { describe, it, expect } from "vitest";
import { kucoinPreset } from "./kucoin.js";

// Real headers from KuCoin export samples
const SPOT_SPLITTING_HEADERS = [
  "UID", "Account Type", "Order ID", "Symbol", "Side", "Order Type",
  "Avg. Filled Price", "Filled Amount", "Filled Volume",
  "Filled Volume (USDT)", "Filled Time(UTC+02:00)", "Fee", "Maker/Taker",
  "Fee Currency", "Tax",
];

const SPOT_NONSPLITTING_HEADERS = [
  "UID", "Account Type", "Order ID", "Order Time(UTC+02:00)", "Symbol",
  "Side", "Order Type", "Order Price", "Order Amount", "Avg. Filled Price",
  "Filled Amount", "Filled Volume", "Filled Volume (USDT)",
  "Filled Time(UTC+02:00)", "Fee", "Fee Currency", "Tax", "Status",
];

const DEPOSIT_HEADERS = [
  "UID", "Account Type", "Time(UTC+02:00)", "Remarks", "Status", "Fee",
  "Amount", "Coin", "Transfer Network",
];

const WITHDRAWAL_HEADERS = [
  "UID", "Account Type", "Time(UTC+02:00)", "Remarks", "Status", "Fee",
  "Amount", "Coin", "Transfer Network", "Withdrawal Address/Account",
];

// Unsupported KuCoin variant
const ACCOUNT_HISTORY_HEADERS = [
  "UID", "Account Type", "Currency", "Side", "Amount", "Fee",
  "Time(UTC+02:00)", "Remark",
];

const EARN_HEADERS = [
  "UID", "Account Type", "Order ID", "Time(UTC+02:00)", "Staked Coin",
  "Product Type", "Product Name", "Earnings Coin", "Earnings Type",
  "Remarks", "Amount", "Amount（USDT）", "Fee",
];

describe("kucoin detection", () => {
  it("detects spot splitting headers", () => {
    expect(kucoinPreset.detect(SPOT_SPLITTING_HEADERS, [])).toBe(85);
  });

  it("detects spot non-splitting headers", () => {
    expect(kucoinPreset.detect(SPOT_NONSPLITTING_HEADERS, [])).toBe(85);
  });

  it("detects deposit headers", () => {
    expect(kucoinPreset.detect(DEPOSIT_HEADERS, [])).toBe(85);
  });

  it("detects withdrawal headers", () => {
    expect(kucoinPreset.detect(WITHDRAWAL_HEADERS, [])).toBe(85);
  });

  it("returns 0 for unsupported KuCoin variants", () => {
    expect(kucoinPreset.detect(ACCOUNT_HISTORY_HEADERS, [])).toBe(0);
    expect(kucoinPreset.detect(EARN_HEADERS, [])).toBe(0);
  });

  it("returns 0 for non-KuCoin headers", () => {
    expect(kucoinPreset.detect(["Date", "Description", "Amount"], [])).toBe(0);
    expect(kucoinPreset.detect(["Date(UTC)", "Pair", "Side", "Price", "Filled", "Total", "Fee", "Fee Coin"], [])).toBe(0);
  });
});

describe("kucoin spot splitting transform", () => {
  it("aggregates multiple fills into one record per order", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER1", "RHOC-BTC", "BUY", "", "0.00000634", "187.911875", "0.00119136", "0", "2019-01-03 19:13:30", "0.18791188", "", "", ""],
      ["****8648", "mainAccount", "ORDER1", "RHOC-BTC", "BUY", "", "0.00000635", "877.908713", "0.00557472", "0", "2019-01-03 19:13:30", "0.87790871", "", "", ""],
      ["****8648", "mainAccount", "ORDER1", "RHOC-BTC", "BUY", "", "0.00000636", "57109.061369", "0.36321363", "0", "2019-01-03 19:13:30", "57.10906137", "", "", ""],
    ];

    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).not.toBeNull();
    expect(records).toHaveLength(1);

    const r = records![0];
    expect(r.date).toBe("2019-01-03");
    expect(r.sourceKey).toBe("ORDER1");
    expect(r.groupKey).toBe("ORDER1");

    // Base sum: 187.911875 + 877.908713 + 57109.061369 = 58174.881957
    const baseLine = r.lines.find((l) => l.currency === "RHOC" && parseFloat(l.amount) > 0);
    expect(baseLine).toBeDefined();
    expect(parseFloat(baseLine!.amount)).toBeCloseTo(58174.881957, 4);

    // Quote sum: 0.00119136 + 0.00557472 + 0.36321363 = 0.36997971
    const quoteLine = r.lines.find((l) => l.currency === "BTC" && parseFloat(l.amount) < 0 && l.account.includes("KuCoin"));
    expect(quoteLine).toBeDefined();
    expect(parseFloat(quoteLine!.amount)).toBeCloseTo(-0.36997971, 6);

    // Fee sum: 0.18791188 + 0.87790871 + 57.10906137 = 58.17488196
    const feeLine = r.lines.find((l) => l.account.includes("Fees"));
    expect(feeLine).toBeDefined();
    expect(parseFloat(feeLine!.amount)).toBeCloseTo(58.17488196, 4);
    // Fee currency inferred as base (BUY)
    expect(feeLine!.currency).toBe("RHOC");
  });

  it("handles single fill order", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER2", "ETH-USDT", "SELL", "", "1800.5", "2.5", "4501.25", "4501.25", "2023-06-15 10:30:00", "4.50125", "", "", ""],
    ];

    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);

    const r = records![0];
    expect(r.date).toBe("2023-06-15");
    // SELL: spend base, receive quote
    const ethLine = r.lines.find((l) => l.currency === "ETH" && parseFloat(l.amount) < 0 && l.account.includes("KuCoin"));
    expect(ethLine).toBeDefined();
    expect(parseFloat(ethLine!.amount)).toBeCloseTo(-2.5);

    const usdtLine = r.lines.find((l) => l.currency === "USDT" && parseFloat(l.amount) > 0);
    expect(usdtLine).toBeDefined();
    expect(parseFloat(usdtLine!.amount)).toBeCloseTo(4501.25);

    // Fee currency inferred as quote (SELL)
    const feeLine = r.lines.find((l) => l.account.includes("Fees"));
    expect(feeLine!.currency).toBe("USDT");
  });

  it("uses explicit Fee Currency when provided", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER3", "BTC-USDT", "BUY", "", "30000", "0.1", "3000", "3000", "2023-01-01 12:00:00", "0.5", "", "KCS", ""],
    ];

    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
    const feeLine = records![0].lines.find((l) => l.account.includes("Fees"));
    expect(feeLine!.currency).toBe("KCS");
  });

  it("handles zero fee", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER4", "BTC-USDT", "BUY", "", "30000", "0.1", "3000", "3000", "2023-01-01 12:00:00", "0", "", "", ""],
    ];

    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
    // No fee lines
    const feeLines = records![0].lines.filter((l) => l.account.includes("Fees"));
    expect(feeLines).toHaveLength(0);
  });

  it("handles multiple orders separately", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER_A", "BTC-USDT", "BUY", "", "30000", "0.1", "3000", "3000", "2023-01-01 12:00:00", "0.0001", "", "", ""],
      ["****8648", "mainAccount", "ORDER_B", "ETH-BTC", "SELL", "", "0.05", "10", "0.5", "15000", "2023-01-02 14:00:00", "0.0005", "", "", ""],
    ];

    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).toHaveLength(2);
    expect(records![0].sourceKey).toBe("ORDER_A");
    expect(records![1].sourceKey).toBe("ORDER_B");
  });

  it("skips empty rows", () => {
    const rows = [[""], ["****8648", "mainAccount", "ORDER5", "BTC-USDT", "BUY", "", "30000", "0.1", "3000", "3000", "2023-01-01 12:00:00", "0", "", "", ""]];
    const records = kucoinPreset.transform(SPOT_SPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
  });
});

describe("kucoin spot non-splitting transform", () => {
  it("transforms a basic BUY trade", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER1", "2023-01-01 10:00:00", "BTC-USDT", "BUY", "limit", "30000", "0.1", "29950", "0.1", "2995", "2995", "2023-01-01 10:01:00", "0.0001", "BTC", "", "Done"],
    ];

    const records = kucoinPreset.transform(SPOT_NONSPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
    expect(records![0].date).toBe("2023-01-01");
    expect(records![0].sourceKey).toBe("ORDER1");
  });

  it("transforms a SELL trade", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER2", "2023-01-01 10:00:00", "ETH-USDT", "SELL", "limit", "1800", "5", "1805", "5", "9025", "9025", "2023-01-01 10:05:00", "9.025", "USDT", "", "Done"],
    ];

    const records = kucoinPreset.transform(SPOT_NONSPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
    const r = records![0];

    const ethLine = r.lines.find((l) => l.currency === "ETH" && parseFloat(l.amount) < 0 && l.account.includes("KuCoin"));
    expect(ethLine).toBeDefined();
    expect(parseFloat(ethLine!.amount)).toBeCloseTo(-5);

    const usdtLine = r.lines.find((l) => l.currency === "USDT" && parseFloat(l.amount) > 0);
    expect(usdtLine).toBeDefined();
    expect(parseFloat(usdtLine!.amount)).toBeCloseTo(9025);
  });

  it("skips cancelled orders (filled amount = 0)", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER3", "2023-01-01 10:00:00", "BTC-USDT", "BUY", "limit", "30000", "0.1", "0", "0", "0", "0", "", "0", "", "", "Cancelled"],
    ];

    const records = kucoinPreset.transform(SPOT_NONSPLITTING_HEADERS, rows);
    expect(records).toHaveLength(0);
  });

  it("infers fee currency when not provided", () => {
    const rows = [
      ["****8648", "mainAccount", "ORDER4", "2023-01-01 10:00:00", "BTC-USDT", "BUY", "limit", "30000", "0.1", "29950", "0.1", "2995", "2995", "2023-01-01 10:01:00", "0.0001", "", "", "Done"],
    ];

    const records = kucoinPreset.transform(SPOT_NONSPLITTING_HEADERS, rows);
    expect(records).toHaveLength(1);
    const feeLine = records![0].lines.find((l) => l.account.includes("Fees"));
    expect(feeLine!.currency).toBe("BTC"); // BUY → base
  });
});

describe("kucoin deposits transform", () => {
  it("transforms a successful deposit", () => {
    const rows = [
      ["****8648", "mainAccount", "2019-01-03 18:35:37", "null", "SUCCESS", "null", "1.72983385", "BTC", "null"],
    ];

    const records = kucoinPreset.transform(DEPOSIT_HEADERS, rows);
    expect(records).toHaveLength(1);

    const r = records![0];
    expect(r.date).toBe("2019-01-03");
    expect(r.description).toContain("Deposit");

    // Amount is positive (deposit)
    const btcLine = r.lines.find((l) => l.currency === "BTC" && l.account.includes("KuCoin"));
    expect(btcLine).toBeDefined();
    expect(parseFloat(btcLine!.amount)).toBeCloseTo(1.72983385);
  });

  it("skips non-SUCCESS deposits", () => {
    const rows = [
      ["****8648", "mainAccount", "2023-01-01 10:00:00", "null", "PROCESSING", "null", "1.0", "ETH", "null"],
    ];

    const records = kucoinPreset.transform(DEPOSIT_HEADERS, rows);
    expect(records).toHaveLength(0);
  });

  it("handles null fee string", () => {
    const rows = [
      ["****8648", "mainAccount", "2023-01-01 10:00:00", "null", "SUCCESS", "null", "100", "USDT", "null"],
    ];

    const records = kucoinPreset.transform(DEPOSIT_HEADERS, rows);
    expect(records).toHaveLength(1);
    // No fee lines (null → 0)
    const feeLines = records![0].lines.filter((l) => l.account.includes("Fees"));
    expect(feeLines).toHaveLength(0);
  });

  it("includes fee when present", () => {
    const rows = [
      ["****8648", "mainAccount", "2023-01-01 10:00:00", "null", "SUCCESS", "0.5", "100", "USDT", "null"],
    ];

    const records = kucoinPreset.transform(DEPOSIT_HEADERS, rows);
    expect(records).toHaveLength(1);
    const feeLine = records![0].lines.find((l) => l.account.includes("Fees"));
    expect(feeLine).toBeDefined();
    expect(parseFloat(feeLine!.amount)).toBeCloseTo(0.5);
  });
});

describe("kucoin withdrawals transform", () => {
  it("transforms a successful withdrawal with negated amount", () => {
    const rows = [
      ["****8648", "mainAccount", "2019-01-03 20:48:03", "null", "SUCCESS", "null", "100000", "RHOC", "null", "0x69d6Da1cd6FBE9C45df732E98C573f025f8dACBC"],
    ];

    const records = kucoinPreset.transform(WITHDRAWAL_HEADERS, rows);
    expect(records).toHaveLength(1);

    const r = records![0];
    expect(r.date).toBe("2019-01-03");
    expect(r.description).toContain("Withdrawal");

    // Amount is negated (withdrawal)
    const rhocLine = r.lines.find((l) => l.currency === "RHOC" && l.account.includes("KuCoin"));
    expect(rhocLine).toBeDefined();
    expect(parseFloat(rhocLine!.amount)).toBeCloseTo(-100000);
  });

  it("skips non-SUCCESS withdrawals", () => {
    const rows = [
      ["****8648", "mainAccount", "2023-01-01 10:00:00", "null", "PENDING", "null", "1.0", "ETH", "null", "0xabc"],
    ];

    const records = kucoinPreset.transform(WITHDRAWAL_HEADERS, rows);
    expect(records).toHaveLength(0);
  });

  it("handles withdrawal with fee", () => {
    const rows = [
      ["****8648", "mainAccount", "2023-01-01 10:00:00", "null", "SUCCESS", "0.001", "1.0", "ETH", "null", "0xabc"],
    ];

    const records = kucoinPreset.transform(WITHDRAWAL_HEADERS, rows);
    expect(records).toHaveLength(1);
    const feeLine = records![0].lines.find((l) => l.account.includes("Fees"));
    expect(feeLine).toBeDefined();
    expect(parseFloat(feeLine!.amount)).toBeCloseTo(0.001);
  });
});

describe("kucoin edge cases", () => {
  it("handles malformed date gracefully", () => {
    const rows = [
      ["****8648", "mainAccount", "bad-date", "null", "SUCCESS", "null", "1.0", "BTC", "null"],
    ];

    const records = kucoinPreset.transform(DEPOSIT_HEADERS, rows);
    expect(records).toHaveLength(0);
  });

  it("handles empty rows in all variants", () => {
    expect(kucoinPreset.transform(DEPOSIT_HEADERS, [[""]])).toHaveLength(0);
    expect(kucoinPreset.transform(WITHDRAWAL_HEADERS, [[""]])).toHaveLength(0);
    expect(kucoinPreset.transform(SPOT_SPLITTING_HEADERS, [[""]])).toHaveLength(0);
    expect(kucoinPreset.transform(SPOT_NONSPLITTING_HEADERS, [[""]])).toHaveLength(0);
  });
});
