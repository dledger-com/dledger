import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import { aaveHandler } from "./aave.js";
import { AAVE } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AAVE_POOL = AAVE.CHAIN_POOLS[1][0]; // V2 pool on mainnet

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
    value: "1000000000", // 1000 USDC (6 decimals)
    contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    tokenName: "USD Coin",
    tokenSymbol: "USDC",
    tokenDecimal: "6",
    ...overrides,
  };
}

describe("aaveHandler", () => {
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
          "pendle": { enabled: true },
          "aave": { enabled: true },
        },
      },
    });
  });

  describe("match", () => {
    it("returns 55 when normal.to is an Aave pool", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is aUSDC (aToken)", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "aUSDC" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 when ERC20 symbol is variableDebtUSDC", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "variableDebtUSDC" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
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
      expect(aaveHandler.match(group, ctx)).toBe(0);
    });
  });

  describe("match", () => {
    it("returns 55 for V3 lowercase aToken like aEthwstETH", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "aEthwstETH" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });

    it("returns 55 for V3 lowercase aToken like aEthtBTC", () => {
      const group = makeEmptyGroup({
        erc20s: [makeErc20({ tokenSymbol: "aEthtBTC" })],
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
    });
  });

  describe("process", () => {
    it("classifies SUPPLY: aToken filtered, only USDC in items", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aUSDC minted from 0x0 to user
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aUSDC",
            tokenName: "Aave interest bearing USDC",
            value: "1000000000",
            tokenDecimal: "6",
          }),
          // USDC sent from user to pool
          makeErc20({
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "USDC",
            tokenName: "USD Coin",
            value: "1000000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description includes "Supply" and the underlying token
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("USDC");

      // Metadata
      expect(entry.metadata.handler).toBe("aave");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.metadata["handler:version"]).toBe("V2");

      // No aUSDC in items — only real currencies
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aUSDC");
      expect(currencies).toContain("USDC");

      // Items should have Assets:Aave:Supply account
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // No currency hints (aTokens filtered, not hinted)
      expect(result.currencyHints).toBeUndefined();
    });

    it("classifies BORROW: debtToken filtered, only DAI in items", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "250000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // variableDebtDAI minted from 0x0 to user
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtDAI",
            tokenName: "Aave variable debt DAI",
            value: "500000000000000000000", // 500 DAI (18 decimals)
            tokenDecimal: "18",
            contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
          }),
          // DAI received from pool to user
          makeErc20({
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            tokenName: "Dai Stablecoin",
            value: "500000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      expect(entry.entry.description).toContain("Borrow");
      expect(entry.entry.description).toContain("DAI");
      expect(entry.metadata["handler:action"]).toBe("BORROW");

      // No variableDebtDAI in items — only real currencies
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("variableDebtDAI");
      expect(currencies).toContain("DAI");

      // Items should have Liabilities:Aave:Borrow account
      const accounts = await backend.listAccounts();
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Aave:Borrow");
      expect(borrowAcct).toBeDefined();
      const borrowItem = entry.items.find((i) => i.account_id === borrowAcct!.id);
      expect(borrowItem).toBeDefined();

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }

      // No currency hints
      expect(result.currencyHints).toBeUndefined();
    });

    it("classifies WITHDRAW: aToken burned + underlying inflow → Assets:Aave:Supply", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aUSDC burned from user to 0x0
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "aUSDC",
            tokenName: "Aave interest bearing USDC",
            value: "1000000000",
            tokenDecimal: "6",
          }),
          // USDC received from pool to user
          makeErc20({
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenName: "USD Coin",
            value: "1000000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Withdraw");
      expect(entry.metadata["handler:action"]).toBe("WITHDRAW");

      // No aUSDC in items
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aUSDC");

      // Should have Assets:Aave:Supply account
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
    });

    it("classifies REPAY: debtToken burned + underlying outflow → Liabilities:Aave:Borrow", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // variableDebtDAI burned from user to 0x0
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "variableDebtDAI",
            tokenName: "Aave variable debt DAI",
            value: "500000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
          }),
          // DAI sent from user to pool
          makeErc20({
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "DAI",
            tokenName: "Dai Stablecoin",
            value: "500000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Repay");
      expect(entry.metadata["handler:action"]).toBe("REPAY");

      // No variableDebtDAI in items
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("variableDebtDAI");

      // Should have Liabilities:Aave:Borrow account
      const accounts = await backend.listAccounts();
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Aave:Borrow");
      expect(borrowAcct).toBeDefined();
      const borrowItem = entry.items.find((i) => i.account_id === borrowAcct!.id);
      expect(borrowItem).toBeDefined();
    });

    it("classifies CLAIM_REWARDS: only inflows → Income:Aave:Rewards", async () => {
      const REWARD_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "150000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // stkAAVE received (reward claim, no aToken/debtToken mint/burn)
          makeErc20({
            from: OTHER_ADDR,
            to: USER_ADDR,
            tokenSymbol: "stkAAVE",
            tokenName: "Staked Aave",
            value: "5000000000000000000", // 5 stkAAVE (18 decimals)
            tokenDecimal: "18",
            contractAddress: REWARD_TOKEN,
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Claim Rewards");
      expect(entry.metadata["handler:action"]).toBe("CLAIM_REWARDS");

      // Should have Income:Aave:Rewards account
      const accounts = await backend.listAccounts();
      const rewardAcct = accounts.find((a) => a.full_name === "Income:Aave:Rewards");
      expect(rewardAcct).toBeDefined();
      const rewardItem = entry.items.find((i) => i.account_id === rewardAcct!.id);
      expect(rewardItem).toBeDefined();
    });
  });
});
