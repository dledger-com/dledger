import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { eigenLayerHandler } from "./eigenlayer.js";
import { EIGENLAYER } from "./addresses.js";

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

describe("eigenLayerHandler", () => {
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
          "eigenlayer": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is StrategyManager", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: EIGENLAYER.STRATEGY_MANAGER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(eigenLayerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is DelegationManager", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: EIGENLAYER.DELEGATION_MANAGER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(eigenLayerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is EIGEN token", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            tokenSymbol: "EIGEN",
            contractAddress: EIGENLAYER.EIGEN_TOKEN,
          }),
        ],
      });
      expect(eigenLayerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 to is StrategyManager", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: EIGENLAYER.STRATEGY_MANAGER,
            tokenSymbol: "stETH",
          }),
        ],
      });
      expect(eigenLayerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(eigenLayerHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(eigenLayerHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies DEPOSIT when stETH sent to StrategyManager", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: EIGENLAYER.STRATEGY_MANAGER,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // stETH outflow to strategy
          makeErc20({
            from: USER_ADDR,
            to: EIGENLAYER.STRATEGY_MANAGER,
            tokenSymbol: "stETH",
            tokenDecimal: "18",
            value: "10000000000000000000", // 10 stETH
          }),
        ],
      });

      const result = await eigenLayerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Deposit");
      expect(entry.metadata.handler).toBe("eigenlayer");
      expect(entry.metadata["handler:action"]).toBe("DEPOSIT");

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

    it("classifies CLAIM_REWARDS when EIGEN inflow with no outflows", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "EIGEN",
            tokenDecimal: "18",
            value: "50000000000000000000", // 50 EIGEN
            contractAddress: EIGENLAYER.EIGEN_TOKEN,
          }),
        ],
      });

      const result = await eigenLayerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Claim Rewards");
      expect(entry.metadata["handler:action"]).toBe("CLAIM_REWARDS");
    });

    it("classifies WITHDRAW when inflow from EigenLayer contracts", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // stETH received from DelegationManager
          makeErc20({
            from: EIGENLAYER.DELEGATION_MANAGER,
            to: USER_ADDR,
            tokenSymbol: "stETH",
            tokenDecimal: "18",
            value: "10000000000000000000", // 10 stETH
          }),
        ],
      });

      const result = await eigenLayerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "EIGEN",
            tokenDecimal: "18",
            value: "1000000000000000000",
            contractAddress: EIGENLAYER.EIGEN_TOKEN,
          }),
        ],
      });

      const result = await eigenLayerHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
