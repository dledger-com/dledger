import { describe, it, expect } from "vitest";
import { voletPreset, parseVoletDate } from "./volet.js";
import { exchangeAssetsCurrency, exchangeFees, EQUITY_TRADING, EQUITY_EXTERNAL } from "$lib/accounts/paths.js";

const HEADERS = [
  "Date, UTC", "Id", "Transaction Type", "API/CSI", "Sender",
  "Debit", "Currency", "Receiver", "Credit", "Currency",
  "Direction", "Status", "Commission", "Currency", "Pays Fee",
  "Note", "Transaction information",
];

describe("parseVoletDate", () => {
  it("parses DD Mon YYYY, HH:mm", () => {
    expect(parseVoletDate("05 Mar 2026, 13:18")).toBe("2026-03-05");
  });

  it("handles single-digit day", () => {
    expect(parseVoletDate("1 Jan 2022, 09:00")).toBe("2022-01-01");
  });

  it("returns null for invalid input", () => {
    expect(parseVoletDate("bad")).toBeNull();
    expect(parseVoletDate("")).toBeNull();
  });
});

describe("voletPreset", () => {
  describe("detect", () => {
    it("scores 85 for Volet headers", () => {
      expect(voletPreset.detect(HEADERS, [])).toBe(85);
    });

    it("scores 85 with sep= prefix", () => {
      const sepHeaders = ["sep=,"];
      expect(voletPreset.detect(sepHeaders, [HEADERS])).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      expect(voletPreset.detect(["Date", "Amount", "Description"], [])).toBe(0);
    });
  });

  describe("transform", () => {
    it("transforms deposits", () => {
      const rows = [
        ["05 Mar 2026, 13:15", "8fba9cff-0e6e-4d74-b981-b90f200d0ca7", "Repayment", "", "", "", "", "user@test.com", "106.32", "EUR", "DEPOSIT", "Completed", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2026-03-05");
      expect(r.description).toBe("Volet deposit: EUR");
      expect(r.sourceKey).toBe("8fba9cff-0e6e-4d74-b981-b90f200d0ca7");

      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Volet", "EUR") && parseFloat(l.amount) === 106.32)).toBe(true);
      expect(r.lines.some((l) => l.account === EQUITY_EXTERNAL && parseFloat(l.amount) === -106.32)).toBe(true);
    });

    it("transforms withdrawals", () => {
      const rows = [
        ["02 Mar 2026, 13:07", "d1673443-cbfa-4a81-a14b-beb011663e43", "System payment", "", "user@test.com", "0.87", "EUR", "", "", "", "WITHDRAWAL", "Completed", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2026-03-02");
      expect(r.description).toBe("Volet withdrawal: EUR");
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Volet", "EUR") && parseFloat(l.amount) === -0.87)).toBe(true);
    });

    it("transforms currency exchange (trade)", () => {
      const rows = [
        ["01 Apr 2023, 17:14", "5f293182-c6c6-4492-bd3c-c89e8ed53774", "Currency exchange", "", "user@test.com", "99.00", "USD", "user@test.com", "90.24", "EUR", "INNER_TRANSACTION", "Completed", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const r = records![0];
      expect(r.date).toBe("2023-04-01");
      expect(r.description).toContain("currency exchange");

      // BUY side: credit currency (EUR) is base, debit currency (USD) is quote
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Volet", "EUR") && parseFloat(l.amount) === 90.24)).toBe(true);
      expect(r.lines.some((l) => l.account === exchangeAssetsCurrency("Volet", "USD") && parseFloat(l.amount) === -99)).toBe(true);
      expect(r.lines.some((l) => l.account === EQUITY_TRADING)).toBe(true);
    });

    it("handles fees", () => {
      const rows = [
        ["15 Mar 2025, 10:58", "b6196641-b75f-415f-beff-631f61936d6a", "Unload from card", "", "", "", "", "user@test.com", "111.53", "EUR", "DEPOSIT", "Completed", "1.00000000", "EUR", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);

      const allLines = records![0].lines;
      expect(allLines.some((l) => l.account === exchangeFees("Volet") && parseFloat(l.amount) === 1)).toBe(true);
    });

    it("skips Canceled rows", () => {
      const rows = [
        ["05 Mar 2026, 13:18", "6199c48e-4241-42e6-aa2f-c2dd8409d51d", "System payment", "", "user@test.com", "1.00", "EUR", "", "", "", "WITHDRAWAL", "Canceled", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(0);
    });

    it("skips count row at end", () => {
      const rows = [
        ["02 Mar 2026, 13:07", "d1673443-cbfa-4a81-a14b-beb011663e43", "System payment", "", "user@test.com", "0.87", "EUR", "", "", "", "WITHDRAWAL", "Completed", "", "", "", "", ""],
        ["18"],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records!).toHaveLength(1);
    });

    it("handles sep= header shift", () => {
      const sepHeaders = ["sep=,"];
      const rows = [
        [...HEADERS],
        ["02 Mar 2026, 13:07", "d1673443-cbfa-4a81-a14b-beb011663e43", "System payment", "", "user@test.com", "0.87", "EUR", "", "", "", "WITHDRAWAL", "Completed", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(sepHeaders, rows);
      expect(records!).toHaveLength(1);
      expect(records![0].date).toBe("2026-03-02");
    });

    it("sets sourceKey to UUID", () => {
      const rows = [
        ["30 Aug 2022, 14:41", "5e2ae71f-1340-4920-aaf1-f63e38e74961", "Ethereum", "", "", "", "", "user@test.com", "75.00", "EUR", "DEPOSIT", "Completed", "", "", "", "", ""],
      ];

      const records = voletPreset.transform(HEADERS, rows);
      expect(records![0].sourceKey).toBe("5e2ae71f-1340-4920-aaf1-f63e38e74961");
    });
  });
});
