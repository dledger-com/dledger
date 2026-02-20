import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { yearnHandler } from "./yearn.js";
import { YEARN } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const YVUSDC_CONTRACT = "0xa354f35829ae975e850e23e9615b11da1b3dc4de";

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

describe("yearnHandler", () => {
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
          "yearn": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when ERC20 symbol is yvUSDC", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "yvUSDC" })],
      });
      expect(yearnHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is yvDAI", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "yvDAI" })],
      });
      expect(yearnHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is yvETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "yvETH" })],
      });
      expect(yearnHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is Yearn V2 registry", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: YEARN.V2_REGISTRY,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(yearnHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(yearnHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(yearnHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies DEPOSIT when yvToken minted + underlying outflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // yvUSDC minted (from 0x0 to user)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "yvUSDC",
            tokenDecimal: "6",
            value: "950000000", // 950 yvUSDC
            contractAddress: YVUSDC_CONTRACT,
          }),
          // USDC outflow (user sends underlying)
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000", // 1000 USDC
          }),
        ],
      });

      const result = await yearnHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Deposit");
      expect(entry.entry.description).toContain("USDC");
      expect(entry.metadata.handler).toBe("yearn");
      expect(entry.metadata["handler:action"]).toBe("DEPOSIT");
      expect(entry.metadata["handler:vault_token"]).toBe("yvUSDC");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // yvToken currency hint should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["yvUSDC"]).toBeNull();
    });

    it("classifies WITHDRAW when yvToken burned + underlying inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // yvUSDC burned (user sends to 0x0)
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "yvUSDC",
            tokenDecimal: "6",
            value: "950000000",
            contractAddress: YVUSDC_CONTRACT,
          }),
          // USDC inflow (user receives underlying)
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1050000000", // 1050 USDC (with yield)
          }),
        ],
      });

      const result = await yearnHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");
    });

    it("classifies HARVEST_REWARDS when only non-yvToken inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // Reward token inflow
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "YFI",
            tokenDecimal: "18",
            value: "100000000000000000", // 0.1 YFI
          }),
        ],
      });

      const result = await yearnHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Harvest Rewards");
      expect(entry.metadata["handler:action"]).toBe("HARVEST_REWARDS");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "yvUSDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
        ],
      });

      const result = await yearnHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
