import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { dolomiteHandler } from "./dolomite.js";
import { DOLOMITE } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC_CONTRACT = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"; // Arbitrum USDC
const MARGIN_ARB = DOLOMITE.MARGIN_BY_CHAIN[42161];

function makeEmptyGroup(overrides: Partial<TxHashGroup> = {}): TxHashGroup {
  return {
    hash: "0xabc123def456",
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
    hash: "0xabc123def456",
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

function makeNormal(to: string, extra: Partial<TxHashGroup["normal"] & object> = {}) {
  return {
    hash: "0xabc123def456",
    timeStamp: "1704067200",
    from: USER_ADDR,
    to,
    value: "0",
    isError: "0",
    gasUsed: "150000",
    gasPrice: "20000000",
    ...extra,
  };
}

describe("dolomiteHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend, {
      chainId: 42161,
      chain: { chain_id: 42161, name: "Arbitrum", native_currency: "ETH", decimals: 18 },
      settings: { handlers: { "dolomite": { enabled: true } } } as never,
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is DolomiteMargin on Arbitrum", () => {
      const group = makeEmptyGroup({ normal: makeNormal(MARGIN_ARB) });
      expect(dolomiteHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is DepositWithdrawalRouter", () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER),
      });
      expect(dolomiteHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is GenericTraderRouter", () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.GENERIC_TRADER_ROUTER),
      });
      expect(dolomiteHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 flows to/from DolomiteMargin", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ from: USER_ADDR, to: MARGIN_ARB })],
      });
      expect(dolomiteHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({ normal: makeNormal(OTHER_ADDR) });
      expect(dolomiteHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 when margin address belongs to a different chain", () => {
      // Ethereum MARGIN address — on Arbitrum ctx, should not match.
      const ethMargin = DOLOMITE.MARGIN_BY_CHAIN[1];
      const group = makeEmptyGroup({ normal: makeNormal(ethMargin) });
      // Ethereum margin is actually shared with Berachain/Base, but NOT
      // Arbitrum which has its own address.
      expect(dolomiteHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SUPPLY when user sends tokens to the DepositWithdrawalRouter", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER),
        erc20s: [makeErc20({ from: USER_ADDR, to: DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER })],
      });
      const result = await dolomiteHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("1000 USDC");

      // Per-currency net = 0.
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const prev = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, prev.plus(new Decimal(item.amount)));
      }
      for (const [, s] of sums) expect(s.isZero()).toBe(true);
    });

    it("classifies WITHDRAW when user receives tokens from DolomiteMargin", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER),
        erc20s: [makeErc20({ from: MARGIN_ARB, to: USER_ADDR })],
      });
      const result = await dolomiteHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;
      expect(result.entries[0].metadata["handler:action"]).toBe("WITHDRAW");
      expect(result.entries[0].entry.description).toContain("Withdraw");
    });

    it("classifies BORROW when user receives tokens via BorrowPositionRouter", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.BORROW_POSITION_ROUTER),
        erc20s: [makeErc20({ from: MARGIN_ARB, to: USER_ADDR })],
      });
      const result = await dolomiteHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;
      expect(result.entries[0].metadata["handler:action"]).toBe("BORROW");
      expect(result.entries[0].entry.description).toContain("Borrow");
    });

    it("classifies MARGIN_TRADE when GenericTraderRouter moves tokens both directions", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.GENERIC_TRADER_ROUTER),
        erc20s: [
          makeErc20({ from: USER_ADDR, to: DOLOMITE.GENERIC_TRADER_ROUTER, tokenSymbol: "USDC" }),
          makeErc20({
            from: MARGIN_ARB,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "500000000000000000",
            contractAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
            tokenName: "Wrapped Ether",
          }),
        ],
      });
      const result = await dolomiteHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;
      expect(result.entries[0].metadata["handler:action"]).toBe("MARGIN_TRADE");
      expect(result.entries[0].entry.description).toContain("Margin trade");
    });

    it("classifies CLAIM_DOLO when only DOLO tokens flow in", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.DOLO_TOKEN),
        erc20s: [
          makeErc20({
            from: DOLOMITE.DOLO_TOKEN,
            to: USER_ADDR,
            contractAddress: DOLOMITE.DOLO_TOKEN,
            tokenSymbol: "DOLO",
            tokenName: "Dolomite",
            tokenDecimal: "18",
            value: "5000000000000000000",
          }),
        ],
      });
      const result = await dolomiteHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;
      expect(result.entries[0].metadata["handler:action"]).toBe("CLAIM_DOLO");
      expect(result.entries[0].entry.description).toContain("Claim DOLO");
    });

    it("includes descriptionData with defi + Dolomite protocol", async () => {
      const group = makeEmptyGroup({
        normal: makeNormal(DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER),
        erc20s: [makeErc20({ from: USER_ADDR, to: DOLOMITE.DEPOSIT_WITHDRAWAL_ROUTER })],
      });
      const result = await dolomiteHandler.process(group, ctx);
      if (result.type !== "entries") throw new Error("expected entries");
      const descData = JSON.parse(result.entries[0].entry.description_data ?? "{}");
      expect(descData).toMatchObject({
        type: "defi",
        protocol: "Dolomite",
        action: "supply",
        chain: "Arbitrum",
      });
    });
  });
});
