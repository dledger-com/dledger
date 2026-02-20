import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx, Erc721Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { lidoHandler } from "./lido.js";
import { LIDO, ZERO_ADDRESS } from "./addresses.js";

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

function makeErc721(overrides: Partial<Erc721Tx> = {}): Erc721Tx {
  return {
    hash: "0x1234567890abcdef",
    timeStamp: "1704067200",
    from: OTHER_ADDR,
    to: USER_ADDR,
    contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    tokenID: "1",
    tokenName: "TestNFT",
    tokenSymbol: "TNFT",
    ...overrides,
  };
}

describe("lidoHandler", () => {
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
          "lido": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is Lido stETH contract", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIDO.STETH,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(lidoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is stETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "stETH" })],
      });
      expect(lidoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is wstETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "wstETH" })],
      });
      expect(lidoHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC721 is from withdrawal queue", () => {
      const group = makeEmptyGroup({
        erc721s: [
          makeErc721({
            contractAddress: LIDO.WITHDRAWAL_QUEUE,
            from: ZERO_ADDRESS,
            to: USER_ADDR,
          }),
        ],
      });
      expect(lidoHandler.match(group, ctx)).toBe(55);
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
      expect(lidoHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies STAKE_ETH when sending ETH to stETH contract + stETH minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIDO.STETH,
          value: "10000000000000000000", // 10 ETH
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            value: "10000000000000000000",
            tokenSymbol: "stETH",
            tokenName: "Lido Staked Ether",
            contractAddress: LIDO.STETH,
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await lidoHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Stake");
      expect(entry.entry.description).toContain("10 ETH");
      expect(entry.entry.description).toContain("stETH");
      expect(entry.metadata.handler).toBe("lido");
      expect(entry.metadata["handler:action"]).toBe("STAKE_ETH");

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

    it("classifies WRAP when stETH out + wstETH in", async () => {
      const wstethAddr = LIDO.WSTETH_BY_CHAIN[1];
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: wstethAddr,
          value: "0",
          isError: "0",
          gasUsed: "80000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: wstethAddr,
            value: "10000000000000000000",
            tokenSymbol: "stETH",
            tokenName: "Lido Staked Ether",
            contractAddress: LIDO.STETH,
            tokenDecimal: "18",
          }),
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            value: "8500000000000000000",
            tokenSymbol: "wstETH",
            tokenName: "Wrapped stETH",
            contractAddress: wstethAddr,
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await lidoHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Wrap");
      expect(entry.metadata["handler:action"]).toBe("WRAP");

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
  });
});
