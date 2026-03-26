import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { morphoHandler } from "./morpho.js";
import { MORPHO } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

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
    value: "1000000000", // 1000 USDC (6 decimals)
    contractAddress: USDC_CONTRACT,
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenDecimal: "6",
    ...overrides,
  };
}

describe("morphoHandler", () => {
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
        theGraphApiKey: "",
        showHidden: false,
        lastRateSync: "",
        debugMode: false,
        holdingPeriodDays: 365,
        handlers: {
          "generic-etherscan": { enabled: true },
          "morpho": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is Morpho Blue", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MORPHO.BLUE,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(morphoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is Morpho Bundler V2", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MORPHO.BUNDLER_V2,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(morphoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 transfer involves Morpho Blue", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({ from: USER_ADDR, to: MORPHO.BLUE }),
        ],
      });
      expect(morphoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 transfer comes from Morpho Blue", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({ from: MORPHO.BLUE, to: USER_ADDR }),
        ],
      });
      expect(morphoHandler.match(group, ctx)).toBe(55);
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
      expect(morphoHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 when there is no normal tx and no Morpho ERC20 transfers", () => {
      const group = makeEmptyGroup();
      expect(morphoHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SUPPLY when user sends tokens to Morpho", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MORPHO.BLUE,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({ from: USER_ADDR, to: MORPHO.BLUE }),
        ],
      });

      const result = await morphoHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Morpho");
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("1000 USDC");

      expect(entry.metadata.handler).toBe("morpho");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");

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

    it("classifies WITHDRAW when user receives tokens from Morpho", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MORPHO.BLUE,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({ from: MORPHO.BLUE, to: USER_ADDR }),
        ],
      });

      const result = await morphoHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Morpho");
      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");
    });
  });
});
