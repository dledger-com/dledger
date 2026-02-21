import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import {
  aaveHandler,
  isAToken,
  isDebtToken,
  extractATokenUnderlying,
  extractDebtTokenUnderlying,
} from "./aave.js";
import { AAVE } from "./addresses.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AAVE_POOL = AAVE.CHAIN_POOLS[1][0]; // V2 pool on mainnet
const AAVE_V3_POOL = AAVE.CHAIN_POOLS[1][1]; // V3 pool on mainnet

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

describe("extractATokenUnderlying", () => {
  it("extracts V2 aToken names", () => {
    expect(extractATokenUnderlying("aUSDC")).toBe("USDC");
    expect(extractATokenUnderlying("aWETH")).toBe("WETH");
    expect(extractATokenUnderlying("aDAI")).toBe("DAI");
    expect(extractATokenUnderlying("aWBTC")).toBe("WBTC");
  });

  it("extracts V3 aToken names with chain prefix", () => {
    expect(extractATokenUnderlying("aEthWETH")).toBe("WETH");
    expect(extractATokenUnderlying("aEthUSDC")).toBe("USDC");
    expect(extractATokenUnderlying("aArbUSDC")).toBe("USDC");
    expect(extractATokenUnderlying("aOptDAI")).toBe("DAI");
    expect(extractATokenUnderlying("aBasDAI")).toBe("DAI");
    expect(extractATokenUnderlying("aPolWPOL")).toBe("WPOL");
  });

  it("extracts V3 lowercase aToken names", () => {
    expect(extractATokenUnderlying("aEthwstETH")).toBe("wstETH");
    expect(extractATokenUnderlying("aEthtBTC")).toBe("tBTC");
  });

  it("returns null for non-aToken symbols", () => {
    expect(extractATokenUnderlying("USDC")).toBeNull();
    expect(extractATokenUnderlying("variableDebtUSDC")).toBeNull();
    expect(extractATokenUnderlying("")).toBeNull();
  });
});

describe("extractDebtTokenUnderlying", () => {
  it("extracts variable debt token underlying", () => {
    expect(extractDebtTokenUnderlying("variableDebtUSDC")).toBe("USDC");
    expect(extractDebtTokenUnderlying("variableDebtDAI")).toBe("DAI");
    expect(extractDebtTokenUnderlying("variableDebtWETH")).toBe("WETH");
  });

  it("extracts stable debt token underlying", () => {
    expect(extractDebtTokenUnderlying("stableDebtDAI")).toBe("DAI");
    expect(extractDebtTokenUnderlying("stableDebtUSDC")).toBe("USDC");
  });

  it("extracts V3 debt tokens with chain prefix", () => {
    expect(extractDebtTokenUnderlying("variableDebtEthUSDC")).toBe("USDC");
    expect(extractDebtTokenUnderlying("variableDebtArbWETH")).toBe("WETH");
    expect(extractDebtTokenUnderlying("stableDebtOptDAI")).toBe("DAI");
  });

  it("returns null for non-debt symbols", () => {
    expect(extractDebtTokenUnderlying("USDC")).toBeNull();
    expect(extractDebtTokenUnderlying("aUSDC")).toBeNull();
    expect(extractDebtTokenUnderlying("")).toBeNull();
  });
});

describe("isAToken / isDebtToken", () => {
  it("identifies aTokens correctly", () => {
    expect(isAToken("aUSDC")).toBe(true);
    expect(isAToken("aEthWETH")).toBe(true);
    expect(isAToken("aEthwstETH")).toBe(true);
    expect(isAToken("aEthtBTC")).toBe(true);
    expect(isAToken("USDC")).toBe(false);
    expect(isAToken("variableDebtUSDC")).toBe(false);
  });

  it("identifies debt tokens correctly", () => {
    expect(isDebtToken("variableDebtUSDC")).toBe(true);
    expect(isDebtToken("stableDebtDAI")).toBe(true);
    expect(isDebtToken("variableDebtEthWETH")).toBe(true);
    expect(isDebtToken("aUSDC")).toBe(false);
    expect(isDebtToken("USDC")).toBe(false);
  });
});

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
    it("classifies SUPPLY: protocol items from aToken mint, USDC in items", async () => {
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

    it("classifies BORROW: protocol items from debtToken mint, DAI in items", async () => {
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

    it("handles V3 aToken names: aEthWETH supply extracts to WETH", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aEthWETH minted from 0x0 to user
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthWETH",
            tokenName: "Aave Ethereum WETH",
            value: "1000000000000000000", // 1 WETH (18 decimals)
            tokenDecimal: "18",
          }),
          // WETH sent from user to pool
          makeErc20({
            from: USER_ADDR,
            to: AAVE_V3_POOL,
            tokenSymbol: "WETH",
            tokenName: "Wrapped Ether",
            value: "1000000000000000000",
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("WETH");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.metadata["handler:version"]).toBe("V3");

      // No aEthWETH in items — only WETH
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWETH");
      expect(currencies).toContain("WETH");

      // Protocol items use WETH, not aEthWETH
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(supplyItem!.currency).toBe("WETH");
    });

    it("handles multi-action: supply WETH + borrow USDC in one tx", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "400000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aEthWETH minted (supply side)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthWETH",
            tokenName: "Aave Ethereum WETH",
            value: "1000000000000000000", // 1 WETH
            tokenDecimal: "18",
          }),
          // WETH sent from user to pool (supply)
          makeErc20({
            from: USER_ADDR,
            to: AAVE_V3_POOL,
            tokenSymbol: "WETH",
            tokenName: "Wrapped Ether",
            value: "1000000000000000000",
            tokenDecimal: "18",
          }),
          // variableDebtEthUSDC minted (borrow side)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtEthUSDC",
            tokenName: "Aave variable debt USDC",
            value: "500000000", // 500 USDC
            tokenDecimal: "6",
          }),
          // USDC received from pool (borrow proceeds)
          makeErc20({
            from: AAVE_V3_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            tokenName: "USD Coin",
            value: "500000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Description includes both actions
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("WETH");
      expect(entry.entry.description).toContain("Borrow");
      expect(entry.entry.description).toContain("USDC");

      // Metadata has comma-joined actions
      expect(entry.metadata["handler:action"]).toContain("SUPPLY");
      expect(entry.metadata["handler:action"]).toContain("BORROW");

      // Has both protocol accounts
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Aave:Borrow");
      expect(supplyAcct).toBeDefined();
      expect(borrowAcct).toBeDefined();

      // Supply item uses WETH, borrow item uses USDC
      const supplyItems = entry.items.filter((i) => i.account_id === supplyAcct!.id);
      const borrowItems = entry.items.filter((i) => i.account_id === borrowAcct!.id);
      expect(supplyItems).toHaveLength(1);
      expect(borrowItems).toHaveLength(1);
      expect(supplyItems[0].currency).toBe("WETH");
      expect(borrowItems[0].currency).toBe("USDC");

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles aToken transfer out: send aEthWETH to another address", async () => {
      const RECIPIENT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const group = makeEmptyGroup({
        erc20s: [
          // aEthWETH transferred from user to recipient (not burn)
          makeErc20({
            from: USER_ADDR,
            to: RECIPIENT,
            tokenSymbol: "aEthWETH",
            tokenName: "Aave Ethereum WETH",
            value: "500000000000000000", // 0.5 WETH
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Should NOT contain aEthWETH in items — uses underlying WETH
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWETH");
      expect(currencies).toContain("WETH");

      // Should have Assets:Aave:Supply with negative WETH (supply decreases)
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(new Decimal(supplyItem!.amount).isNegative()).toBe(true);

      // Should have counterparty Equity:*:External:* with positive WETH
      const externalItem = entry.items.find(
        (i) => {
          const acct = accounts.find((a) => a.id === i.account_id);
          return acct?.full_name.startsWith("Equity:") && acct.full_name.includes(":External:");
        },
      );
      expect(externalItem).toBeDefined();
      expect(new Decimal(externalItem!.amount).isPositive()).toBe(true);

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles swap+supply: receive WETH from DEX then supply to Aave in one tx", async () => {
      const DEX_ADDR = "0xdef1c0ded9bec7f1a1670819833240f027b25eff";
      const ATOKEN_ADDR = "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8"; // aEthWETH contract
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "400000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // Step 1: WETH received from DEX to user (swap output)
          makeErc20({
            from: DEX_ADDR,
            to: USER_ADDR,
            tokenSymbol: "WETH",
            tokenName: "Wrapped Ether",
            value: "1000000000000000000", // 1 WETH
            tokenDecimal: "18",
          }),
          // Step 2: WETH sent from user to aToken contract (supply input)
          makeErc20({
            from: USER_ADDR,
            to: ATOKEN_ADDR,
            tokenSymbol: "WETH",
            tokenName: "Wrapped Ether",
            value: "1000000000000000000", // 1 WETH
            tokenDecimal: "18",
          }),
          // Step 3: aEthWETH minted (protocol receipt)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthWETH",
            tokenName: "Aave Ethereum WETH",
            value: "1000000000000000000", // 1 WETH equivalent
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Should have Supply action
      expect(entry.entry.description).toContain("Supply");
      expect(entry.entry.description).toContain("WETH");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");

      // No aEthWETH in items
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWETH");

      // Should preserve the DEX counterparty (Equity:*:External:* with negative WETH)
      const accounts = await backend.listAccounts();
      const externalItems = entry.items.filter((i) => {
        const acct = accounts.find((a) => a.id === i.account_id);
        return acct?.full_name.startsWith("Equity:") && acct.full_name.includes(":External:");
      });
      // DEX counterparty should still be present
      expect(externalItems.length).toBeGreaterThanOrEqual(1);

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles DEPOSIT_ETH: native ETH via WrappedTokenGateway → Supply +ETH", async () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE.WRAPPED_TOKEN_GATEWAY,
          value: "1000000000000000000", // 1 ETH
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aEthWETH minted (protocol receipt for the ETH deposit)
          makeErc20({
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthWETH",
            tokenName: "Aave Ethereum WETH",
            value: "1000000000000000000", // 1 WETH equivalent
            tokenDecimal: "18",
          }),
        ],
        internals: [],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Description should mention Supply
      expect(entry.entry.description).toContain("Supply");

      // No WETH or aEthWETH in items — should use native ETH
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWETH");
      expect(currencies).not.toContain("WETH");
      expect(currencies).toContain("ETH");

      // Should have Assets:Aave:Supply with ETH
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(supplyItem!.currency).toBe("ETH");
      expect(new Decimal(supplyItem!.amount).isPositive()).toBe(true);

      // Items balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });
  });
});
