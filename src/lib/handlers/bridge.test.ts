import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { bridgeHandler } from "./bridge.js";
import { BRIDGES } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACROSS_SPOKE_POOL_ETH = BRIDGES.ACROSS_SPOKE_POOLS[1]!;
const STARGATE_POOL = BRIDGES.STARGATE_POOLS_ETH[0];
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

describe("bridgeHandler", () => {
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
          "bridge": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 50 when normal.to is Across SpokePool (chain 1)", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ACROSS_SPOKE_POOL_ETH,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(bridgeHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when normal.to is Stargate pool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: STARGATE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(bridgeHandler.match(group, ctx)).toBe(50);
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
      expect(bridgeHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 when there is no normal tx", () => {
      const group = makeEmptyGroup();
      expect(bridgeHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies BRIDGE_DEPOSIT when user sends tokens to bridge", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ACROSS_SPOKE_POOL_ETH,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({ from: USER_ADDR, to: ACROSS_SPOKE_POOL_ETH }),
        ],
      });

      const result = await bridgeHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Across");
      expect(entry.entry.description).toContain("Bridge");
      expect(entry.entry.description).toContain("1000 USDC");

      expect(entry.metadata.handler).toBe("bridge");
      expect(entry.metadata["handler:action"]).toBe("BRIDGE_DEPOSIT");
      expect(entry.metadata["handler:protocol"]).toBe("across");

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

    it("classifies BRIDGE_FILL when user receives tokens from bridge", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: OTHER_ADDR,
          to: ACROSS_SPOKE_POOL_ETH,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({ from: ACROSS_SPOKE_POOL_ETH, to: USER_ADDR }),
        ],
      });

      const result = await bridgeHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Across");
      expect(entry.entry.description).toContain("Receive");
      expect(entry.metadata["handler:action"]).toBe("BRIDGE_FILL");
      expect(entry.metadata["handler:protocol"]).toBe("across");
    });

    it("uses Stargate protocol name for Stargate pools", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: STARGATE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({ from: USER_ADDR, to: STARGATE_POOL }),
        ],
      });

      const result = await bridgeHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("Stargate");
      expect(result.entries[0].metadata["handler:protocol"]).toBe("stargate");
    });
  });
});
