import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { rewardClaimHandler } from "./reward-claim.js";
import { REWARD_CLAIMS } from "./addresses.js";

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

describe("rewardClaimHandler", () => {
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
          "reward-claim": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 52 when normal.to is Merkl distributor", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: REWARD_CLAIMS.MERKL_DISTRIBUTOR,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(rewardClaimHandler.match(group, ctx)).toBe(52);
    });

    it("returns 52 when normal.to is Votium multi merkle", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: REWARD_CLAIMS.VOTIUM_MULTI_MERKLE,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(rewardClaimHandler.match(group, ctx)).toBe(52);
    });

    it("returns 52 when ERC20 from is Merkl distributor", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: REWARD_CLAIMS.MERKL_DISTRIBUTOR,
            to: USER_ADDR,
            tokenSymbol: "ARB",
          }),
        ],
      });
      expect(rewardClaimHandler.match(group, ctx)).toBe(52);
    });

    it("returns 52 when internal tx from is Votium", () => {
      const group = makeEmptyGroup({
        internals: [
          {
            hash: "0x1234567890abcdef",
            timeStamp: "1704067200",
            from: REWARD_CLAIMS.VOTIUM_MULTI_MERKLE,
            to: USER_ADDR,
            value: "1000000000000000000",
            isError: "0",
            traceId: "0",
          },
        ],
      });
      expect(rewardClaimHandler.match(group, ctx)).toBe(52);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(rewardClaimHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(rewardClaimHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("processes Merkl claim with reward token inflow", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: REWARD_CLAIMS.MERKL_DISTRIBUTOR,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: REWARD_CLAIMS.MERKL_DISTRIBUTOR,
            to: USER_ADDR,
            tokenSymbol: "ARB",
            tokenDecimal: "18",
            value: "50000000000000000000", // 50 ARB
          }),
        ],
      });

      const result = await rewardClaimHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Merkl");
      expect(entry.entry.description).toContain("Claim");
      expect(entry.metadata.handler).toBe("reward-claim");
      expect(entry.metadata["handler:action"]).toBe("CLAIM");
      expect(entry.metadata["handler:protocol"]).toBe("Merkl");

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

    it("processes Votium claim", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: REWARD_CLAIMS.VOTIUM_MULTI_MERKLE,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: REWARD_CLAIMS.VOTIUM_MULTI_MERKLE,
            to: USER_ADDR,
            tokenSymbol: "CVX",
            tokenDecimal: "18",
            value: "100000000000000000000", // 100 CVX
          }),
        ],
      });

      const result = await rewardClaimHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Votium");
      expect(entry.metadata["handler:protocol"]).toBe("Votium");
    });

    it("returns skip when no net movement", async () => {
      // Self-transfer with no normal tx (no gas fees) = cancels out
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "ARB",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await rewardClaimHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
