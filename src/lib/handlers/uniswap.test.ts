import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx, Erc721Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { uniswapHandler } from "./uniswap.js";
import { UNISWAP } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LP_POOL_ADDR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function makeErc721(overrides: Partial<Erc721Tx> = {}): Erc721Tx {
  return {
    hash: "0x1234567890abcdef",
    timeStamp: "1704067200",
    from: OTHER_ADDR,
    to: USER_ADDR,
    contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
    tokenID: "12345",
    tokenName: "Uniswap V3 Positions NFT-V1",
    tokenSymbol: "UNI-V3-POS",
    ...overrides,
  };
}

function makeNormalTx(to: string, overrides: Record<string, string> = {}) {
  return {
    hash: "0x1234567890abcdef",
    timeStamp: "1704067200",
    from: USER_ADDR,
    to,
    value: "0",
    isError: "0",
    gasUsed: "150000",
    gasPrice: "20000000000",
    ...overrides,
  };
}

describe("uniswapHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
    ctx.settings.handlers["uniswap"] = { enabled: true };
  });

  describe("match", () => {
    it("returns 55 when normal.to is a Uniswap V2 router", () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V2_ROUTER),
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is a Uniswap V3 router", () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V3_ROUTER),
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is the Universal Router", () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.UNIVERSAL_ROUTER),
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is the V4 Universal Router", () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V4_UNIVERSAL_ROUTER),
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is UNI-V2", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "UNI-V2" })],
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC721 symbol is UNI-V3-POS", () => {
      const group = makeEmptyGroup({
        erc721s: [makeErc721()],
      });
      expect(uniswapHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(OTHER_ADDR),
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(uniswapHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SWAP with token outflow + inflow", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.UNIVERSAL_ROUTER),
        erc20s: [
          // USDC outflow from user
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "100000000", // 100 USDC
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          // WETH inflow to user
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "50000000000000000", // 0.05 WETH
            contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description contains "Swap"
      expect(entry.entry.description).toContain("Swap");
      expect(entry.entry.description).toContain("USDC");
      expect(entry.entry.description).toContain("WETH");

      // Metadata
      expect(entry.metadata.handler).toBe("uniswap");
      expect(entry.metadata["handler:action"]).toBe("SWAP");

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("classifies ADD_LIQUIDITY_V2 with UNI-V2 minted", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V2_ROUTER),
        erc20s: [
          // UNI-V2 LP token minted to user from 0x0
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "UNI-V2",
            tokenDecimal: "18",
            value: "5000000000000000000",
            contractAddress: LP_POOL_ADDR,
          }),
          // Token A outflow
          makeErc20({
            from: USER_ADDR,
            to: LP_POOL_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "100000000",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          // Token B outflow
          makeErc20({
            from: USER_ADDR,
            to: LP_POOL_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "50000000000000000",
            contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description
      expect(entry.entry.description).toContain("Add Liquidity V2");

      // Metadata
      expect(entry.metadata.handler).toBe("uniswap");
      expect(entry.metadata["handler:action"]).toBe("ADD_LIQUIDITY_V2");
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

      // Currency hints: UNI-V2 should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["UNI-V2"]).toBeNull();
    });

    it("classifies REMOVE_LIQUIDITY_V2 with UNI-V2 burned", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V2_ROUTER),
        erc20s: [
          // UNI-V2 LP token burned from user to 0x0
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "UNI-V2",
            tokenDecimal: "18",
            value: "5000000000000000000",
            contractAddress: LP_POOL_ADDR,
          }),
          // Token A inflow
          makeErc20({
            from: LP_POOL_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "100000000",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
          // Token B inflow
          makeErc20({
            from: LP_POOL_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "50000000000000000",
            contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("Remove Liquidity V2");
      expect(result.entries[0].metadata["handler:action"]).toBe("REMOVE_LIQUIDITY_V2");
      expect(result.entries[0].metadata["handler:version"]).toBe("V2");
    });

    it("classifies MINT_POSITION_V3 with UNI-V3-POS NFT minted", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.POSITION_MANAGER_V3),
        erc721s: [
          makeErc721({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
          }),
        ],
        erc20s: [
          // Token outflow for position
          makeErc20({
            from: USER_ADDR,
            to: UNISWAP.POSITION_MANAGER_V3,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "100000000",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("Mint Position V3");
      expect(result.entries[0].metadata["handler:action"]).toBe("MINT_POSITION_V3");
      expect(result.entries[0].metadata["handler:version"]).toBe("V3");
    });

    it("classifies COLLECT_FEES_V3 with ERC20 inflows from PositionManager", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.POSITION_MANAGER_V3),
        erc20s: [
          makeErc20({
            from: UNISWAP.POSITION_MANAGER_V3,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "5000000",
            contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("Collect Fees V3");
      expect(result.entries[0].metadata["handler:action"]).toBe("COLLECT_FEES_V3");
    });

    it("detects V4 version when using V4 universal router", async () => {
      const group = makeEmptyGroup({
        normal: makeNormalTx(UNISWAP.V4_UNIVERSAL_ROUTER),
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "100000000",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "50000000000000000",
          }),
        ],
      });

      const result = await uniswapHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:version"]).toBe("V4");
    });
  });
});
