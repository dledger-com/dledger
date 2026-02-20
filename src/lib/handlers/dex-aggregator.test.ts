import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { dexAggregatorHandler } from "./dex-aggregator.js";
import { AGGREGATORS } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ONEINCH_ROUTER = "0x1111111254eeb25477b68fb85ed929f73a960582";
const COW_SETTLEMENT = AGGREGATORS.COW_PROTOCOL;

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

describe("dexAggregatorHandler", () => {
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
          "dex-aggregator": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 50 when normal.to starts with 0x111111 (1inch)", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ONEINCH_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(dexAggregatorHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when normal.to is 0x ExchangeProxy", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AGGREGATORS.ZEROX_PROXY,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(dexAggregatorHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when normal.to is CoW settlement", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: COW_SETTLEMENT,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(dexAggregatorHandler.match(group, ctx)).toBe(50);
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
      expect(dexAggregatorHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("produces a SWAP entry via 1inch with correct description and metadata", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ONEINCH_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            value: "100000000", // 100 USDC (6 decimals)
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            value: "50000000000000000", // 0.05 WETH
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          }),
        ],
      });

      const result = await dexAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description contains protocol name and swap info
      expect(entry.entry.description).toContain("1inch");
      expect(entry.entry.description).toContain("Swap");
      expect(entry.entry.description).toContain("USDC");
      expect(entry.entry.description).toContain("WETH");

      // Metadata
      expect(entry.metadata.handler).toBe("dex-aggregator");
      expect(entry.metadata["handler:action"]).toBe("SWAP");
      expect(entry.metadata["handler:protocol"]).toBe("1inch");

      // Items balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("produces a SWAP entry via CoW Protocol with correct protocol metadata", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0xabcdef1234567890",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: COW_SETTLEMENT,
          value: "0",
          isError: "0",
          gasUsed: "150000",
          gasPrice: "15000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            value: "1000000000000000000", // 1 DAI
            tokenSymbol: "DAI",
            tokenDecimal: "18",
            contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            value: "1000000", // 1 USDC
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
        ],
      });

      const result = await dexAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("CoW Protocol");
      expect(entry.entry.description).toContain("Swap");
      expect(entry.metadata["handler:protocol"]).toBe("cow");
      expect(entry.metadata["handler:action"]).toBe("SWAP");
    });
  });
});
