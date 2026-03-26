import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { synthetixHandler } from "./synthetix.js";
import { SYNTHETIX } from "./addresses.js";

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

describe("synthetixHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 55 when normal.to is V3_CORE_OPTIMISM", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: SYNTHETIX.V3_CORE_OPTIMISM,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(synthetixHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is SNX_TOKEN", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: SYNTHETIX.SNX_TOKEN,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(synthetixHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when SNX token from Synthetix contract", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: SYNTHETIX.SNX_TOKEN,
            to: USER_ADDR,
            tokenSymbol: "SNX",
          }),
        ],
      });
      expect(synthetixHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when sUSD with Synthetix contract interaction", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: SYNTHETIX.V3_CORE_OPTIMISM,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "sUSD",
          }),
        ],
      });
      expect(synthetixHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for SNX token without Synthetix contract interaction", () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "SNX",
          }),
        ],
      });
      expect(synthetixHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for synth pattern without Synthetix contract", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "sETH" })],
      });
      expect(synthetixHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(synthetixHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies DEPOSIT_COLLATERAL when SNX sent to Synthetix", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: SYNTHETIX.V3_CORE_OPTIMISM,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: SYNTHETIX.V3_CORE_OPTIMISM,
            tokenSymbol: "SNX",
            tokenDecimal: "18",
            value: "1000000000000000000000",
            contractAddress: SYNTHETIX.SNX_TOKEN,
          }),
        ],
      });

      const result = await synthetixHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Deposit Collateral");
      expect(entry.metadata.handler).toBe("synthetix");
      expect(entry.metadata["handler:action"]).toBe("DEPOSIT_COLLATERAL");
    });

    it("classifies CLAIM_REWARDS when SNX inflow with no outflows", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: SYNTHETIX.V3_CORE_OPTIMISM,
            to: USER_ADDR,
            tokenSymbol: "SNX",
            tokenDecimal: "18",
            value: "50000000000000000000",
            contractAddress: SYNTHETIX.SNX_TOKEN,
          }),
        ],
      });

      const result = await synthetixHandler.process(group, ctx);
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
            tokenSymbol: "SNX",
            tokenDecimal: "18",
            value: "1000000000000000000",
            contractAddress: SYNTHETIX.SNX_TOKEN,
          }),
        ],
      });

      const result = await synthetixHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
