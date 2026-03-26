import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { notionalHandler } from "./notional.js";
import { NOTIONAL } from "./addresses.js";

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

describe("notionalHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 55 when normal.to is V3_PROXY", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: NOTIONAL.V3_PROXY,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(notionalHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 from is V3_PROXY", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: NOTIONAL.V3_PROXY,
            to: USER_ADDR,
            tokenSymbol: "USDC",
          }),
        ],
      });
      expect(notionalHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 to is V3_PROXY", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: NOTIONAL.V3_PROXY,
            tokenSymbol: "USDC",
          }),
        ],
      });
      expect(notionalHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when nToken with Notional contract interaction", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: NOTIONAL.V3_PROXY,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [makeErc20({ tokenSymbol: "nUSDC" })],
      });
      expect(notionalHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for nToken without Notional contract", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "nUSDC" })],
      });
      expect(notionalHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(notionalHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(notionalHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies LEND when underlying outflow to proxy", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: NOTIONAL.V3_PROXY,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: NOTIONAL.V3_PROXY,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "10000000000",
          }),
        ],
      });

      const result = await notionalHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Lend");
      expect(entry.metadata.handler).toBe("notional");
      expect(entry.metadata["handler:action"]).toBe("LEND");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000",
          }),
        ],
      });

      const result = await notionalHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
