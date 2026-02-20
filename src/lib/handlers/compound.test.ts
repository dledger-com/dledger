import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { compoundHandler } from "./compound.js";
import { COMPOUND } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CUSDC_CONTRACT = "0x39aa39c021dfbae8fac545936693ac917d5e7563";

function makeEmptyGroup(overrides: Partial<TxHashGroup> = {}): TxHashGroup {
  return {
    hash: "0x1234abcdef567890",
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
    hash: "0x1234abcdef567890",
    timeStamp: "1704067200",
    from: OTHER_ADDR,
    to: USER_ADDR,
    value: "1000000000", // 1000 USDC (6 decimals)
    contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenDecimal: "6",
    ...overrides,
  };
}

describe("compoundHandler", () => {
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
          "compound": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when ERC20 symbol is cUSDC", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "cUSDC" })],
      });
      expect(compoundHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is cUSDCv3", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "cUSDCv3" })],
      });
      expect(compoundHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is Comptroller", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234abcdef567890",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: COMPOUND.COMPTROLLER,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(compoundHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(compoundHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(compoundHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SUPPLY when cToken minted + underlying outflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // cUSDC minted (from 0x0 to user)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "cUSDC",
            tokenDecimal: "8",
            value: "5000000000", // 50 cUSDC
            contractAddress: CUSDC_CONTRACT,
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

      const result = await compoundHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("1000 USDC");
      expect(entry.entry.description).toContain("0x1234abcd");
      expect(entry.metadata.handler).toBe("compound");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.metadata["handler:version"]).toBe("V2");
      expect(entry.metadata["handler:ctoken"]).toBe("cUSDC");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // cToken currency hint should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["cUSDC"]).toBeNull();
    });

    it("classifies WITHDRAW when cToken burned + underlying inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // cUSDC burned (user sends to 0x0)
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "cUSDC",
            tokenDecimal: "8",
            value: "5000000000",
            contractAddress: CUSDC_CONTRACT,
          }),
          // USDC inflow (user receives underlying)
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
        ],
      });

      const result = await compoundHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");
    });

    it("classifies V3 when cToken symbol ends with v3", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "cUSDCv3",
            tokenDecimal: "6",
            value: "1000000000",
            contractAddress: COMPOUND.V3_COMETS[1][0],
          }),
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
        ],
      });

      const result = await compoundHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:version"]).toBe("V3");
    });

    it("classifies CLAIM_COMP when only COMP inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: COMPOUND.COMPTROLLER,
            to: USER_ADDR,
            tokenSymbol: "COMP",
            tokenDecimal: "18",
            value: "500000000000000000", // 0.5 COMP
            contractAddress: "0xc00e94cb662c3520282e6f5717214004a7f26888",
          }),
        ],
      });

      const result = await compoundHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("Claim COMP");
      expect(result.entries[0].metadata["handler:action"]).toBe("CLAIM_COMP");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "cUSDC",
            tokenDecimal: "8",
            value: "1000000000",
          }),
        ],
      });

      const result = await compoundHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
