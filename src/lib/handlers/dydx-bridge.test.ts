import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { dydxBridgeHandler } from "./dydx-bridge.js";
import { DYDX } from "./addresses.js";

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

describe("dydxBridgeHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 50 when normal.to is STARKEX_BRIDGE", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: DYDX.STARKEX_BRIDGE,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when normal.to is SAFETY_MODULE", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: DYDX.SAFETY_MODULE,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when ERC20 DYDX to Safety Module", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: DYDX.SAFETY_MODULE,
            tokenSymbol: "DYDX",
            contractAddress: DYDX.DYDX_TOKEN,
          }),
        ],
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(50);
    });

    it("returns 50 when ERC20 to StarkEx bridge", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: DYDX.STARKEX_BRIDGE,
            tokenSymbol: "USDC",
          }),
        ],
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(50);
    });

    it("returns 0 for DYDX token without dYdX contract", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "DYDX",
          }),
        ],
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(dydxBridgeHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(dydxBridgeHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies BRIDGE_DEPOSIT when USDC sent to StarkEx bridge", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: DYDX.STARKEX_BRIDGE,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: DYDX.STARKEX_BRIDGE,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "10000000000",
          }),
        ],
      });

      const result = await dydxBridgeHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Bridge Deposit");
      expect(entry.metadata.handler).toBe("dydx-bridge");
      expect(entry.metadata["handler:action"]).toBe("BRIDGE_DEPOSIT");
    });

    it("classifies STAKE_DYDX when DYDX sent to Safety Module", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: DYDX.SAFETY_MODULE,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: DYDX.SAFETY_MODULE,
            tokenSymbol: "DYDX",
            tokenDecimal: "18",
            value: "1000000000000000000000",
            contractAddress: DYDX.DYDX_TOKEN,
          }),
        ],
      });

      const result = await dydxBridgeHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Stake DYDX");
      expect(entry.metadata["handler:action"]).toBe("STAKE_DYDX");
    });

    it("classifies CLAIM_REWARDS when DYDX inflow with no outflows", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: DYDX.SAFETY_MODULE,
            to: USER_ADDR,
            tokenSymbol: "DYDX",
            tokenDecimal: "18",
            value: "50000000000000000000",
            contractAddress: DYDX.DYDX_TOKEN,
          }),
        ],
      });

      const result = await dydxBridgeHandler.process(group, ctx);
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
            tokenSymbol: "DYDX",
            tokenDecimal: "18",
            value: "1000000000000000000",
            contractAddress: DYDX.DYDX_TOKEN,
          }),
        ],
      });

      const result = await dydxBridgeHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
