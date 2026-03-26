import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { gmxHandler } from "./gmx.js";
import { GMX } from "./addresses.js";

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

describe("gmxHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend, {
      chainId: 42161,
      chain: { chain_id: 42161, name: "Arbitrum", native_currency: "ETH", decimals: 18 },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is V2_EXCHANGE_ROUTER", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: GMX.V2_EXCHANGE_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(gmxHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is V1_VAULT", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: GMX.V1_VAULT,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(gmxHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is GLP token", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "GLP" })],
      });
      expect(gmxHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is GM: token", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "GM:ETH-USDC" })],
      });
      expect(gmxHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is GM- token", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "GM-ETH" })],
      });
      expect(gmxHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(gmxHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(gmxHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies ADD_LIQUIDITY when GLP minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: GMX.GLP_MANAGER,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "GLP",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await gmxHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Add Liquidity");
      expect(entry.metadata.handler).toBe("gmx");
      expect(entry.metadata["handler:action"]).toBe("ADD_LIQUIDITY");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "GLP",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await gmxHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
