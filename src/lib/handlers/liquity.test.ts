import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { liquityHandler } from "./liquity.js";
import { LIQUITY } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LUSD_CONTRACT = "0x5f98805a4e8be255a32880fdec7f6728c6568ba0";
const LQTY_CONTRACT = "0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d";

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

describe("liquityHandler", () => {
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
          "liquity": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when ERC20 symbol is LUSD", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "LUSD" })],
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is LQTY", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "LQTY" })],
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is BorrowerOperations", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.BORROWER_OPERATIONS,
          value: "1000000000000000000",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is StabilityPool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.STABILITY_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is LQTYStaking", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.LQTY_STAKING,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when normal.to is TroveManager", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.TROVE_MANAGER,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(liquityHandler.match(group, ctx)).toBe(55);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(liquityHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(liquityHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies OPEN_TROVE when LUSD minted via BorrowerOperations", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.BORROWER_OPERATIONS,
          value: "5000000000000000000", // 5 ETH collateral
          isError: "0",
          gasUsed: "500000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // LUSD minted (from 0x0)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "LUSD",
            tokenDecimal: "18",
            value: "10000000000000000000000", // 10000 LUSD
            contractAddress: LUSD_CONTRACT,
          }),
        ],
      });

      const result = await liquityHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Open Trove");
      expect(entry.entry.description).toContain("LUSD");
      expect(entry.metadata.handler).toBe("liquity");
      expect(entry.metadata["handler:action"]).toBe("OPEN_TROVE");
    });

    it("classifies STABILITY_DEPOSIT when LUSD sent to StabilityPool", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.STABILITY_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // LUSD outflow to StabilityPool
          makeErc20({
            from: USER_ADDR,
            to: LIQUITY.STABILITY_POOL,
            tokenSymbol: "LUSD",
            tokenDecimal: "18",
            value: "5000000000000000000000", // 5000 LUSD
            contractAddress: LUSD_CONTRACT,
          }),
        ],
      });

      const result = await liquityHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Stability Deposit");
      expect(entry.metadata["handler:action"]).toBe("STABILITY_DEPOSIT");
    });

    it("classifies STABILITY_WITHDRAW when LUSD received from StabilityPool", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: LIQUITY.STABILITY_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // LUSD inflow from StabilityPool
          makeErc20({
            from: LIQUITY.STABILITY_POOL,
            to: USER_ADDR,
            tokenSymbol: "LUSD",
            tokenDecimal: "18",
            value: "5000000000000000000000", // 5000 LUSD
            contractAddress: LUSD_CONTRACT,
          }),
        ],
      });

      const result = await liquityHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Stability Withdraw");
      expect(entry.metadata["handler:action"]).toBe("STABILITY_WITHDRAW");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "LUSD",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await liquityHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
