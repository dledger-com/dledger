import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { originHandler } from "./origin.js";
import { ORIGIN } from "./addresses.js";

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

describe("originHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 55 when normal.to is OUSD_VAULT", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ORIGIN.OUSD_VAULT,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(originHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is OETH_VAULT", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ORIGIN.OETH_VAULT,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(originHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is OUSD", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "OUSD" })],
      });
      expect(originHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 is WOETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "WOETH" })],
      });
      expect(originHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(originHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(originHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies MINT when OUSD minted", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ORIGIN.OUSD_VAULT,
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
            tokenSymbol: "OUSD",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await originHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Mint");
      expect(entry.metadata.handler).toBe("origin");
      expect(entry.metadata["handler:action"]).toBe("MINT");
    });

    it("classifies WRAP when OUSD→WOUSD", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "OUSD",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WOUSD",
            tokenDecimal: "18",
            value: "900000000000000000",
          }),
        ],
      });

      const result = await originHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].metadata["handler:action"]).toBe("WRAP");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "OUSD",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await originHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
