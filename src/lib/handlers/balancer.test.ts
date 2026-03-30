import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { balancerHandler } from "./balancer.js";
import { BALANCER } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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

describe("balancerHandler", () => {
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
          "balancer": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is Balancer Vault", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: BALANCER.VAULT,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(balancerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol starts with B-", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "B-stETH-STABLE" })],
      });
      expect(balancerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is BAL token", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            tokenSymbol: "BAL",
            contractAddress: BALANCER.BAL_TOKEN,
          }),
        ],
      });
      expect(balancerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 from/to is Vault", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: BALANCER.VAULT,
            to: USER_ADDR,
            tokenSymbol: "WETH",
          }),
        ],
      });
      expect(balancerHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(balancerHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(balancerHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies JOIN_POOL when BPT minted + underlying outflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // BPT minted (from 0x0 to user)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "B-stETH-STABLE",
            tokenDecimal: "18",
            value: "5000000000000000000", // 5 BPT
            contractAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }),
          // WETH outflow
          makeErc20({
            from: USER_ADDR,
            to: BALANCER.VAULT,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "2000000000000000000", // 2 WETH
          }),
        ],
      });

      const result = await balancerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Join Pool");
      expect(entry.metadata.handler).toBe("balancer");
      expect(entry.metadata["handler:action"]).toBe("JOIN_POOL");
      expect(entry.metadata["handler:bpt_token"]).toBe("B-stETH-STABLE");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // BPT currency hint should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["B-stETH-STABLE"]).toBeNull();
    });

    it("classifies EXIT_POOL when BPT burned + underlying inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // BPT burned (user sends to 0x0)
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "B-stETH-STABLE",
            tokenDecimal: "18",
            value: "5000000000000000000",
            contractAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }),
          // WETH inflow
          makeErc20({
            from: BALANCER.VAULT,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "2100000000000000000", // 2.1 WETH
          }),
        ],
      });

      const result = await balancerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Exit Pool");
      expect(entry.metadata["handler:action"]).toBe("EXIT_POOL");
    });

    it("classifies SWAP when non-BPT tokens exchanged via Vault", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: BALANCER.VAULT,
          value: "0",
          isError: "0",
          gasUsed: "150000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // USDC outflow
          makeErc20({
            from: USER_ADDR,
            to: BALANCER.VAULT,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000", // 1000 USDC
          }),
          // DAI inflow
          makeErc20({
            from: BALANCER.VAULT,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            tokenDecimal: "18",
            value: "999000000000000000000", // 999 DAI
          }),
        ],
      });

      const result = await balancerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Swap");
      expect(entry.metadata["handler:action"]).toBe("SWAP");
    });

    it("classifies CLAIM_REWARDS when only BAL inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: BALANCER.GAUGE_CONTROLLER,
            to: USER_ADDR,
            tokenSymbol: "BAL",
            tokenDecimal: "18",
            value: "10000000000000000000", // 10 BAL
            contractAddress: BALANCER.BAL_TOKEN,
          }),
        ],
      });

      const result = await balancerHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Claim Rewards");
      expect(entry.metadata["handler:action"]).toBe("CLAIM_REWARDS");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "B-stETH-STABLE",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await balancerHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
