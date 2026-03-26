import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { vaultAggregatorHandler } from "./vault-aggregator.js";
import { VAULT_AGGREGATORS } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

describe("vaultAggregatorHandler", () => {
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
          "vault-aggregator": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 53 when ERC20 symbol starts with moo (Beefy)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "mooAaveETH" })],
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 53 when ERC20 symbol starts with fX (Harvest)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "fUSDC" })],
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 53 when normal.to is Harvest controller", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VAULT_AGGREGATORS.HARVEST_CONTROLLER,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 53 when normal.to is Sommelier registry", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VAULT_AGGREGATORS.SOMMELIER_REGISTRY,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 53 when normal.to is Badger Sett vault", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VAULT_AGGREGATORS.BADGER_SETT_VAULT,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 53 when ERC20 from is a known vault contract", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ from: VAULT_AGGREGATORS.HARVEST_CONTROLLER, tokenSymbol: "USDC" })],
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(53);
    });

    it("returns 0 for unrelated tx", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "USDC" })],
      });
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(0);
    });

    it("returns 0 for empty group", () => {
      const group = makeEmptyGroup();
      expect(vaultAggregatorHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("process", () => {
    it("classifies DEPOSIT when vault share minted + underlying outflow (Beefy)", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // mooToken minted (from 0x0 to user)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "mooAaveETH",
            tokenDecimal: "18",
            value: "950000000000000000", // 0.95 mooAaveETH
            contractAddress: VAULT_CONTRACT,
          }),
          // ETH outflow (user sends underlying as WETH)
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "1000000000000000000", // 1 WETH
          }),
        ],
      });

      const result = await vaultAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Beefy");
      expect(entry.entry.description).toContain("Deposit");
      expect(entry.entry.description).toContain("WETH");
      expect(entry.metadata.handler).toBe("vault-aggregator");
      expect(entry.metadata["handler:action"]).toBe("DEPOSIT");
      expect(entry.metadata["handler:protocol"]).toBe("Beefy");
      expect(entry.metadata["handler:vault_token"]).toBe("mooAaveETH");

      // Items should balance per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // Vault share token currency hint should be null
      expect(result.currencyHints).toBeDefined();
      expect(result.currencyHints!["mooAaveETH"]).toBeNull();
    });

    it("classifies WITHDRAW when vault share burned + underlying inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // mooToken burned (user sends to 0x0)
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "mooAaveETH",
            tokenDecimal: "18",
            value: "950000000000000000",
            contractAddress: VAULT_CONTRACT,
          }),
          // WETH inflow (user receives underlying)
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenDecimal: "18",
            value: "1050000000000000000", // 1.05 WETH (with yield)
          }),
        ],
      });

      const result = await vaultAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");
    });

    it("classifies CLAIM_REWARDS when only non-vault-share inflow", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          // Reward token inflow
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "CRV",
            tokenDecimal: "18",
            value: "100000000000000000", // 0.1 CRV
          }),
        ],
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VAULT_AGGREGATORS.HARVEST_CONTROLLER,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
      });

      const result = await vaultAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Claim Rewards");
      expect(entry.metadata["handler:action"]).toBe("CLAIM_REWARDS");
      expect(entry.metadata["handler:protocol"]).toBe("Harvest");
    });

    it("detects Harvest protocol from contract address", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: VAULT_AGGREGATORS.HARVEST_CONTROLLER,
          value: "0",
          isError: "0",
          gasUsed: "100000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "fUSDC",
            tokenDecimal: "6",
            value: "1000000000",
            contractAddress: VAULT_CONTRACT,
          }),
          makeErc20({
            from: USER_ADDR,
            to: OTHER_ADDR,
            tokenSymbol: "USDC",
            tokenDecimal: "6",
            value: "1000000000",
          }),
        ],
      });

      const result = await vaultAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries[0].metadata["handler:protocol"]).toBe("Harvest");
    });

    it("returns skip when no net movement", async () => {
      const group = makeEmptyGroup({
        erc20s: [
          makeErc20({
            from: USER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "mooAaveETH",
            tokenDecimal: "18",
            value: "1000000000000000000",
          }),
        ],
      });

      const result = await vaultAggregatorHandler.process(group, ctx);
      expect(result.type).toBe("skip");
    });
  });
});
