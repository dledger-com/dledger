import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { aaveHandler } from "./aave.js";
import { AAVE } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AAVE_POOL = AAVE.CHAIN_POOLS[1][0]; // V2 pool on mainnet

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
    contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenDecimal: "6",
    ...overrides,
  };
}

describe("aaveHandler", () => {
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
        holdingPeriodDays: 365,
        handlers: {
          "generic-etherscan": { enabled: true },
          "pendle": { enabled: true },
          "aave": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is an Aave pool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is aUSDC (aToken)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "aUSDC" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is variableDebtUSDC", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "variableDebtUSDC" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
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
      expect(aaveHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SUPPLY: aToken minted + underlying outflow", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aUSDC minted from 0x0 to user
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aUSDC",
            tokenName: "Aave interest bearing USDC",
            value: "1000000000",
            tokenDecimal: "6",
          }),
          // USDC sent from user to pool
          makeErc20({
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "USDC",
            tokenName: "USD Coin",
            value: "1000000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description includes "Supply" and the underlying token
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("USDC");

      // Metadata
      expect(entry.metadata.handler).toBe("aave");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.metadata["handler:version"]).toBe("V2");

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // Currency hints: aUSDC should be null (no auto-pricing)
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["aUSDC"]).toBeNull();
    });

    it("classifies BORROW: debtToken minted + underlying inflow", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "250000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // variableDebtDAI minted from 0x0 to user
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtDAI",
            tokenName: "Aave variable debt DAI",
            value: "500000000000000000000", // 500 DAI (18 decimals)
            tokenDecimal: "18",
            contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
          }),
          // DAI received from pool to user
          makeErc20({
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            tokenName: "Dai Stablecoin",
            value: "500000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Borrow");
      expect(entry.entry.description).toContain("DAI");
      expect(entry.metadata["handler:action"]).toBe("BORROW");

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // Currency hints: variableDebtDAI should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["variableDebtDAI"]).toBeNull();
    });
  });
});
