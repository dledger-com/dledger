import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { convexHandler } from "./convex.js";
import { CONVEX } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

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

describe("convexHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 60 when normal.to is Booster", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: CONVEX.BOOSTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(convexHandler.match(group, ctx)).toBe(60);
    });

    it("returns 60 when normal.to is CVX Reward Pool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: CONVEX.CVX_REWARD_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(convexHandler.match(group, ctx)).toBe(60);
    });

    it("returns 60 when ERC20 is CVX token", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            tokenSymbol: "CVX",
            contractAddress: CONVEX.CVX_TOKEN,
          }),
        ],
      });
      expect(convexHandler.match(group, ctx)).toBe(60);
    });

    it("returns 60 when ERC20 is cvxCRV token", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            tokenSymbol: "cvxCRV",
            contractAddress: CONVEX.CVX_CRV,
          }),
        ],
      });
      expect(convexHandler.match(group, ctx)).toBe(60);
    });

    it("returns 60 for cvx-prefixed token symbol", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({ tokenSymbol: "cvxsteCRV" }),
        ],
      });
      expect(convexHandler.match(group, ctx)).toBe(60);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(convexHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(convexHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies DEPOSIT when LP outflow + cvx token minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: CONVEX.BOOSTER,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // LP outflow
          makeErc20({
            from: USER_ADDR,
            to: CONVEX.BOOSTER,
            tokenSymbol: "crvUSD",
            value: "10000000000000000000",
          }),
          // cvx token minted
          makeErc20({
            from: ZERO_ADDR,
            to: USER_ADDR,
            tokenSymbol: "cvxcrvUSD",
            value: "10000000000000000000",
          }),
        ],
      });

      const result = await convexHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Deposit");
      expect(result.entries[0].metadata["handler:action"]).toBe("DEPOSIT");
    });

    it("classifies CLAIM_REWARDS when CRV/CVX inflows with no outflows", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "CRV",
            value: "50000000000000000000",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "CVX",
            value: "25000000000000000000",
            contractAddress: CONVEX.CVX_TOKEN,
          }),
        ],
      });

      const result = await convexHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Claim Rewards");
      expect(result.entries[0].metadata["handler:action"]).toBe("CLAIM_REWARDS");
    });

    it("classifies WITHDRAW when cvx token burned + LP inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // cvx token burned
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDR,
            tokenSymbol: "cvxcrvUSD",
            value: "10000000000000000000",
          }),
          // LP inflow
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "crvUSD",
            value: "10000000000000000000",
          }),
        ],
      });

      const result = await convexHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Withdraw");
      expect(result.entries[0].metadata["handler:action"]).toBe("WITHDRAW");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "CVX",
            contractAddress: CONVEX.CVX_TOKEN,
          }),
        ],
      });

      const result = await convexHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
