import { describe, it, expect } from "vitest";
import { cryptoComExchangePreset } from "./crypto-com-exchange.js";

const REAL_HEADERS = ["Date", "Monnaie", "Type", "Quantité", "Frais", "TXID", "Informations", "Statut"];

const PREAMBLE_HEADERS = [
  "Vous comprenez et acceptez que le contenu de ce document reprend les ordres...",
];

const PREAMBLE_ROWS = [
  ["L'exportation contient un maximum de 65 000 éléments..."],
  ["Date d'exportation: 2024-06-03 12:57:14"],
  REAL_HEADERS,
  [
    "2020-04-30 09:02:15(2020-04-30 07:02:15 UTC)",
    "CRO(undefined)",
    "Retrait",
    "95000",
    "0",
    "631005af-753d-4f17-b252-11028e08628f",
    "Adresse: Vers l'Application Crypto.com",
    "Terminé",
  ],
  [
    "2020-04-30 08:56:24(2020-04-30 06:56:24 UTC)",
    "VET(undefined)",
    "Dépôt",
    "10000",
    "0",
    "747d0b00-7682-4023-9f4b-d04d902fc067",
    "Adresse: Depuis l'Application Crypto.com",
    "Terminé",
  ],
];

describe("cryptoComExchangePreset", () => {
  describe("detect", () => {
    it("scores 85 for direct headers", () => {
      expect(cryptoComExchangePreset.detect(REAL_HEADERS, [])).toBe(85);
    });

    it("scores 85 with preamble headers when real headers in rows", () => {
      expect(cryptoComExchangePreset.detect(PREAMBLE_HEADERS, PREAMBLE_ROWS)).toBe(85);
    });

    it("scores 0 for unrelated headers", () => {
      expect(cryptoComExchangePreset.detect(["Date", "Description", "Amount"], [])).toBe(0);
    });

    it("scores 85 for English variant headers", () => {
      expect(
        cryptoComExchangePreset.detect(
          ["Date", "Currency", "Type", "Quantity", "Fee", "TXID", "Information", "Status"],
          [],
        ),
      ).toBe(85);
    });
  });

  describe("transform", () => {
    it("transforms direct headers correctly", () => {
      const rows = [
        [
          "2020-04-30 09:02:15(2020-04-30 07:02:15 UTC)",
          "CRO(undefined)",
          "Retrait",
          "95000",
          "0",
          "txid1",
          "info",
          "Terminé",
        ],
        [
          "2020-04-30 08:56:24(2020-04-30 06:56:24 UTC)",
          "VET(undefined)",
          "Dépôt",
          "10000",
          "0",
          "txid2",
          "info",
          "Terminé",
        ],
      ];

      const records = cryptoComExchangePreset.transform(REAL_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);

      // First record: withdrawal
      expect(records![0].date).toBe("2020-04-30");
      expect(records![0].description).toContain("withdrawal");
      expect(records![0].lines[0].currency).toBe("CRO");

      // Second record: deposit
      expect(records![1].date).toBe("2020-04-30");
      expect(records![1].description).toContain("deposit");
      expect(records![1].lines[0].currency).toBe("VET");
    });

    it("transforms with preamble rows", () => {
      const records = cryptoComExchangePreset.transform(PREAMBLE_HEADERS, PREAMBLE_ROWS);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);
      expect(records![0].lines[0].currency).toBe("CRO");
      expect(records![1].lines[0].currency).toBe("VET");
    });

    it("strips (undefined) from currency codes", () => {
      const rows = [
        ["2020-04-30 09:00:00", "BTC(undefined)", "Deposit", "1", "0", "tx", "info", "Terminé"],
      ];
      const records = cryptoComExchangePreset.transform(REAL_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records![0].lines[0].currency).toBe("BTC");
    });

    it("filters by Terminé status", () => {
      const rows = [
        ["2020-04-30 09:00:00", "BTC", "Deposit", "1", "0", "tx", "info", "Terminé"],
        ["2020-04-30 09:00:00", "ETH", "Deposit", "1", "0", "tx", "info", "En attente"],
      ];
      const records = cryptoComExchangePreset.transform(REAL_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(1);
      expect(records![0].lines[0].currency).toBe("BTC");
    });

    it("handles French types Dépôt and Retrait", () => {
      const rows = [
        ["2020-04-30 09:00:00", "CRO", "Dépôt", "100", "0", "tx1", "info", "Terminé"],
        ["2020-04-30 09:00:00", "CRO", "Retrait", "50", "0", "tx2", "info", "Terminé"],
      ];
      const records = cryptoComExchangePreset.transform(REAL_HEADERS, rows);
      expect(records).not.toBeNull();
      expect(records!).toHaveLength(2);
      expect(records![0].description).toContain("deposit");
      expect(records![1].description).toContain("withdrawal");
    });

    it("returns null for unrecognized headers without preamble match", () => {
      const records = cryptoComExchangePreset.transform(["A", "B", "C"], [["x", "y", "z"]]);
      expect(records).toBeNull();
    });
  });
});
