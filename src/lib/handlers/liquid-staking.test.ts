import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { liquidStakingHandler } from "./liquid-staking.js";
import { LIQUID_STAKING, ZERO_ADDRESS } from "./addresses.js";

const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RETH_CONTRACT = LIQUID_STAKING["rocket-pool"].contracts[1][0];
const WEETH_CONTRACT = LIQUID_STAKING["ether-fi"].contracts[1][1];

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
    value: "1000000000000000000", // 1 token (18 decimals)
    contractAddress: RETH_CONTRACT,
    tokenName: "Rocket Pool ETH",
    tokenSymbol: "RETH",
    tokenDecimal: "18",
    ...overrides,
  };
}

describe("liquidStakingHandler", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  describe("match", () => {
    it("returns 55 when ERC-20 symbol is a known LST token (RETH)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "RETH" })],
      });
      expect(liquidStakingHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC-20 symbol is WEETH (ether.fi)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "WEETH", contractAddress: WEETH_CONTRACT })],
      });
      expect(liquidStakingHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is a known LST contract", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: RETH_CONTRACT,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(liquidStakingHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: OTHER_ADDR,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "21000",
          gasPrice: "20000000000",
        },
      });
      expect(liquidStakingHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 when there is no normal tx and no ERC-20s", () => {
      const group = makeEmptyGroup();
      expect(liquidStakingHandler.match(group, ctx)).toBe(0);
    });

    it("returns 55 for each supported protocol token", () => {
      for (const [, protocol] of Object.entries(LIQUID_STAKING)) {
        for (const token of protocol.tokens) {
          const group = makeEmptyGroup({
            erc20s: [makeErc20({ tokenSymbol: token as string })],
          });
          expect(liquidStakingHandler.match(group, ctx)).toBe(55);
        }
      }
    });
  });

  describe("process", () => {
    it("classifies STAKE when LST is minted from 0x0", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: RETH_CONTRACT,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "RETH",
            contractAddress: RETH_CONTRACT,
          }),
        ],
      });

      const result = await liquidStakingHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Rocket Pool");
      expect(entry.entry.description).toContain("Stake");
      expect(entry.metadata.handler).toBe("liquid-staking");
      expect(entry.metadata["handler:action"]).toBe("STAKE");
      expect(entry.metadata["handler:protocol"]).toBe("rocket-pool");
    });

    it("classifies UNSTAKE when LST is burned to 0x0", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: RETH_CONTRACT,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "RETH",
            contractAddress: RETH_CONTRACT,
          }),
        ],
      });

      const result = await liquidStakingHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:action"]).toBe("UNSTAKE");
      expect(result.entries[0].entry.description).toContain("Unstake");
    });

    it("uses correct protocol name for ether.fi", async () => {
      const eethContract = LIQUID_STAKING["ether-fi"].contracts[1][0];
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: eethContract,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "EETH",
            contractAddress: eethContract,
          }),
        ],
      });

      const result = await liquidStakingHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].entry.description).toContain("ether.fi");
      expect(result.entries[0].metadata["handler:protocol"]).toBe("ether-fi");
    });
  });
});
