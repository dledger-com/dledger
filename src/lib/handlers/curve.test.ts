import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { curveHandler } from "./curve.js";
import { CURVE } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeEmptyGroup(overrides: Partial<TxHashGroup> = {}): TxHashGroup {
  return {
    hash: "0x1234567890abcdef",
    timestamp: "1704067200",
    normal: null,
    internals: [],
    erc20s: [],
    erc721s: [],
    erc1155s: [],
    ...overrides,
  };
}

function makeErc20(overrides: Partial<Erc20Tx> = {}): Erc20Tx {
  return {
    hash: "0x1234567890abcdef",
    timeStamp: "1704067200",
    from: OTHER_ADDR,
    to: USER_ADDR,
    value: "1000000000000000000",
    contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    tokenName: "TestToken",
    tokenSymbol: "TEST",
    tokenDecimal: "18",
    ...overrides,
  };
}

describe("curveHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend, {
      settings: {
        currency: "USD",
        dateFormat: "YYYY-MM-DD",
        fiscalYearStart: "01-01",
        etherscanApiKey: "",
        coingeckoApiKey: "",
        finnhubApiKey: "",
        showHidden: false,
        lastRateSync: "",
        debugMode: false,
        handlers: {
          "generic-etherscan": { enabled: true },
          "pendle": { enabled: true },
          "curve": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is Curve Router NG", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: CURVE.ROUTER_NG,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(curveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol contains 'crv'", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "3Crv" })],
      });
      expect(curveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol ends with '-gauge'", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "3Crv-gauge" })],
      });
      expect(curveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 from CRV_MINTER", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ from: CURVE.CRV_MINTER, tokenSymbol: "CRV" })],
      });
      expect(curveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: OTHER_ADDR,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "21000",
          gasPrice: "20000000000",
        },
      });
      expect(curveHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SWAP and includes description", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: CURVE.ROUTER_NG,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // USDC outflow from user
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000", // 1000 USDC
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          // DAI inflow to user
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            tokenDecimal: "18",
            value: "999000000000000000000", // 999 DAI
            contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
          }),
        ],
      });

      const result = await curveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Swap");
      expect(entry.entry.description).toContain("USDC");
      expect(entry.entry.description).toContain("DAI");
      expect(entry.metadata.handler).toBe("curve");
      expect(entry.metadata["handler:action"]).toBe("SWAP");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("classifies ADD_LIQUIDITY when LP minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: OTHER_ADDR,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // Underlying USDC outflow
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          // LP token minted from 0x0
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "3Crv",
            tokenDecimal: "18",
            value: "990000000000000000000",
            contractAddress: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
          }),
        ],
      });

      const result = await curveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:action"]).toBe("ADD_LIQUIDITY");
      expect(result.entries[0].entry.description).toContain("Add Liquidity");

      // 3Crv should be in currency hints as null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["3Crv"]).toBeNull();
    });

    it("classifies CLAIM_CRV when CRV received from Minter", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: CURVE.CRV_MINTER,
            to: USER_ADDR,
            tokenSymbol: "CRV",
            tokenDecimal: "18",
            value: "5000000000000000000000",
            contractAddress: CURVE.CRV_TOKEN,
          }),
        ],
      });

      const result = await curveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:action"]).toBe("CLAIM_CRV");
      expect(result.entries[0].entry.description).toContain("Claim CRV");
    });
  });
});
