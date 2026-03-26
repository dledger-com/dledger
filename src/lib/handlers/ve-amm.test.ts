import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { veAmmHandler } from "./ve-amm.js";
import { VE_AMM } from "./addresses.js";

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

describe("veAmmHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend, {
      chainId: 8453,
      chain: {
        chain_id: 8453,
        name: "Base",
        native_currency: "ETH",
        decimals: 18,
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is Aerodrome Router", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VE_AMM.AERODROME_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(veAmmHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is Velodrome Router", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VE_AMM.VELODROME_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(veAmmHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 has AERO symbol", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "AERO" })],
      });
      expect(veAmmHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 has VELO symbol", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "VELO" })],
      });
      expect(veAmmHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(veAmmHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(veAmmHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies SWAP when inflow + outflow via router", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VE_AMM.AERODROME_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
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
            tokenSymbol: "WETH",
            value: "500000000000000000",
          }),
        ],
      });

      const result = await veAmmHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Swap");
      expect(result.entries[0].entry.description).toContain("Aerodrome");
      expect(result.entries[0].metadata["handler:action"]).toBe("SWAP");
      expect(result.entries[0].metadata["handler:protocol"]).toBe("aerodrome");
    });

    it("classifies CLAIM_EMISSIONS when AERO inflow with no outflows", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "AERO",
            value: "100000000000000000000",
          }),
        ],
      });

      const result = await veAmmHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Claim Emissions");
      expect(result.entries[0].metadata["handler:action"]).toBe("CLAIM_EMISSIONS");
    });

    it("classifies ADD_LIQUIDITY when LP token minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VE_AMM.AERODROME_ROUTER,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // Underlying outflows
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "WETH",
            value: "500000000000000000",
          }),
          // LP minted
          makeErc20({
            from: ZERO_ADDR,
            to: USER_ADDR,
            tokenSymbol: "vAMM-USDC/WETH",
            value: "10000000000000000000",
          }),
        ],
      });

      const result = await veAmmHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Add Liquidity");
      expect(result.entries[0].metadata["handler:action"]).toBe("ADD_LIQUIDITY");
    });

    it("classifies REMOVE_LIQUIDITY when LP token burned", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // LP burned
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDR,
            tokenSymbol: "sAMM-USDC/DAI",
            value: "10000000000000000000",
          }),
          // Underlying inflows
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            value: "1000000000000000000000",
          }),
        ],
      });

      const result = await veAmmHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].entry.description).toContain("Remove Liquidity");
      expect(result.entries[0].metadata["handler:action"]).toBe("REMOVE_LIQUIDITY");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "AERO",
          }),
        ],
      });

      const result = await veAmmHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
