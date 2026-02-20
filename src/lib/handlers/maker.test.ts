import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { makerHandler } from "./maker.js";
import { MAKER } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DAI_CONTRACT = "0x6b175474e89094c44da98b954eedeac495271d0f";

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

describe("makerHandler", () => {
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
          "maker": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when ERC20 symbol is sDAI", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "sDAI" })],
      });
      expect(makerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is spWETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "spWETH" })],
      });
      expect(makerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is spDAI", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "spDAI" })],
      });
      expect(makerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is Spark Pool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MAKER.SPARK_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(makerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is sDAI contract", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: MAKER.SDAI,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(makerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(makerHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(makerHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SDAI_WRAP when DAI out + sDAI minted", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // DAI outflow
          makeErc20({
            from: USER_ADDR,
            to: MAKER.SDAI,
            tokenSymbol: "DAI",
            tokenDecimal: "18",
            value: "10000000000000000000000", // 10000 DAI
            contractAddress: DAI_CONTRACT,
          }),
          // sDAI minted
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "sDAI",
            tokenDecimal: "18",
            value: "9500000000000000000000", // 9500 sDAI
            contractAddress: MAKER.SDAI,
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Wrap DAI to sDAI");
      expect(entry.entry.description).toContain("DAI");
      expect(entry.metadata.handler).toBe("maker");
      expect(entry.metadata["handler:action"]).toBe("SDAI_WRAP");
      expect(entry.metadata["handler:protocol_token"]).toBe("sDAI");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // sDAI currency hint should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["sDAI"]).toBeNull();
    });

    it("classifies SDAI_UNWRAP when sDAI burned + DAI inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // sDAI burned
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "sDAI",
            tokenDecimal: "18",
            value: "9500000000000000000000",
            contractAddress: MAKER.SDAI,
          }),
          // DAI inflow
          makeErc20({
            from: MAKER.SDAI,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            tokenDecimal: "18",
            value: "10200000000000000000000", // 10200 DAI (with yield)
            contractAddress: DAI_CONTRACT,
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Unwrap sDAI to DAI");
      expect(entry.metadata["handler:action"]).toBe("SDAI_UNWRAP");
    });

    it("classifies SPARK_SUPPLY when spToken minted + underlying outflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // spWETH minted
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "spWETH",
            tokenDecimal: "18",
            value: "5000000000000000000", // 5 spWETH
          }),
          // WETH outflow
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "5000000000000000000", // 5 WETH
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Supply");
      expect(entry.metadata["handler:action"]).toBe("SPARK_SUPPLY");
    });

    it("classifies SPARK_WITHDRAW when spToken burned + underlying inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // spWETH burned
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "spWETH",
            tokenDecimal: "18",
            value: "5000000000000000000",
          }),
          // WETH inflow
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "5000000000000000000",
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("SPARK_WITHDRAW");
    });

    it("classifies SPARK_BORROW when non-protocol inflow only", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // USDC inflow (borrow)
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "5000000000", // 5000 USDC
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Borrow");
      expect(entry.metadata["handler:action"]).toBe("SPARK_BORROW");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "sDAI",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await makerHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
