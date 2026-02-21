import { describe, it, expect, beforeEach, vi } from "vitest";
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
import {
  rayToApy,
  fetchAaveSubgraphData,
  prefetchAaveSubgraphBatch,
  clearAaveSubgraphCache,
} from "./aave-subgraph.js";

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

    it("classifies LIQUIDATION via subgraph enrichment", async () => {
      // Mock fetch to return subgraph response with liquidation
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            supplies: [],
            borrows: [],
            redeemUnderlyings: [],
            repays: [],
            liquidationCalls: [{
              collateralAmount: "500000000000000000", // 0.5 WETH
              principalAmount: "800000000", // 800 USDC
              liquidator: "0x9999999999999999999999999999999999999999",
              collateralAssetPriceUSD: "2000.00",
              borrowAssetPriceUSD: "1.00",
              collateralReserve: {
                symbol: "WETH",
                liquidityRate: "32847293847293847293847293",
                variableBorrowRate: "52847293847293847293847293",
                totalATokenSupply: "1000000000000000000000",
                availableLiquidity: "500000000000000000000",
              },
              principalReserve: {
                symbol: "USDC",
                liquidityRate: "12847293847293847293847293",
                variableBorrowRate: "42847293847293847293847293",
                totalATokenSupply: "5000000000000",
                availableLiquidity: "2000000000000",
              },
            }],
          },
        }),
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        // Create context with enrichment enabled
        const enrichedCtx = createMockHandlerContext(backend, {
          settings: {
            currency: "USD",
            dateFormat: "YYYY-MM-DD",
            fiscalYearStart: "01-01",
            etherscanApiKey: "",
            coingeckoApiKey: "",
            finnhubApiKey: "",
            theGraphApiKey: "test-api-key",
            showHidden: false,
            lastRateSync: "",
            debugMode: false,
            holdingPeriodDays: 365,
            handlers: {
              "aave": { enabled: true, enrichment: true },
            },
          },
        });
        // Enable enrichment on context
        (enrichedCtx as { enrichment?: boolean }).enrichment = true;

        // Liquidation tx: aToken burned (collateral seized) + debtToken burned (debt repaid)
        const group = makeEmptyGroup({
          normal: {
            hash: "0x1234567890abcdef",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: AAVE_V3_POOL,
            value: "0",
            isError: "0",
            gasUsed: "300000",
            gasPrice: "20000000000",
          },
          erc20s: [
            // aEthWETH burned (collateral seized by liquidator)
            makeErc20({
              from: USER_ADDR,
              to: ZERO_ADDRESS,
              tokenSymbol: "aEthWETH",
              tokenName: "Aave Ethereum WETH",
              value: "500000000000000000", // 0.5 WETH
              tokenDecimal: "18",
            }),
            // variableDebtEthUSDC burned (debt repaid by liquidator)
            makeErc20({
              from: USER_ADDR,
              to: ZERO_ADDRESS,
              tokenSymbol: "variableDebtEthUSDC",
              tokenName: "Aave variable debt USDC",
              value: "800000000", // 800 USDC
              tokenDecimal: "6",
            }),
          ],
        });

        const result = await aaveHandler.process(group, enrichedCtx);
        expect(result.type).toBe("entries");
        if (result.type !== "entries") return;

        const entry = result.entries[0];

        // Description mentions "Liquidation"
        expect(entry.entry.description).toContain("Liquidation");

        // Action is LIQUIDATION
        expect(entry.metadata["handler:action"]).toBe("LIQUIDATION");

        // Liquidation metadata populated
        expect(entry.metadata["handler:liquidator"]).toBe("0x9999999999999999999999999999999999999999");
        expect(entry.metadata["handler:collateral_asset"]).toBe("WETH");
        expect(entry.metadata["handler:collateral_amount"]).toBe("500000000000000000");
        expect(entry.metadata["handler:debt_asset"]).toBe("USDC");
        expect(entry.metadata["handler:debt_amount"]).toBe("800000000");

        // Enrichment data present
        expect(entry.metadata["handler:supply_apy"]).toBeDefined();
        expect(entry.metadata["handler:borrow_apy"]).toBeDefined();
        expect(entry.metadata["handler:asset_price_usd"]).toBe("2000.00");
        expect(entry.metadata["handler:utilization_rate"]).toBeDefined();
        expect(entry.metadata["handler:total_liquidity"]).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("rayToApy", () => {
  it("converts a known RAY rate to a reasonable APY", () => {
    // ~3.28% variable rate in RAY
    const apy = rayToApy("32847293847293847293847293");
    const apyNum = Number(apy);
    // Should be a reasonable APY (between 0 and 1, i.e. 0-100%)
    expect(apyNum).toBeGreaterThan(0);
    expect(apyNum).toBeLessThan(1);
    // Roughly 3.3% APY
    expect(apyNum).toBeGreaterThan(0.03);
    expect(apyNum).toBeLessThan(0.04);
  });

  it("returns '0' for zero rate", () => {
    expect(rayToApy("0")).toBe("0");
  });

  it("handles a high rate (10% in RAY)", () => {
    // 10% per-second rate in RAY = 0.1e27 / SECONDS_PER_YEAR ≈ 3.17e18 per second
    // But actual Aave rates are per-second already, so 100000000000000000000000000 = 10%
    const apy = rayToApy("100000000000000000000000000");
    const apyNum = Number(apy);
    // ~10.5% APY (compounded)
    expect(apyNum).toBeGreaterThan(0.1);
    expect(apyNum).toBeLessThan(0.12);
  });
});

describe("prefetchAaveSubgraphBatch", () => {
  const MOCK_RESERVE = {
    symbol: "USDC",
    liquidityRate: "32847293847293847293847293",
    variableBorrowRate: "52847293847293847293847293",
    totalATokenSupply: "1000000000000",
    availableLiquidity: "500000000000",
  };

  beforeEach(() => {
    clearAaveSubgraphCache();
  });

  it("populates cache so fetchAaveSubgraphData returns without extra fetch", async () => {
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;

    // Build response with aliased fields for 2 tx hashes
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          data: {
            tx0_supplies: [{ amount: "1000", assetPriceUSD: "1.00", reserve: MOCK_RESERVE }],
            tx0_borrows: [],
            tx0_redeemUnderlyings: [],
            tx0_repays: [],
            tx0_liquidationCalls: [],
            tx1_supplies: [],
            tx1_borrows: [{ amount: "500", assetPriceUSD: "1.00", reserve: MOCK_RESERVE }],
            tx1_redeemUnderlyings: [],
            tx1_repays: [],
            tx1_liquidationCalls: [],
          },
        }),
      };
    });

    try {
      await prefetchAaveSubgraphBatch("test-key", 1, [
        { hash: "0xaaa", isV2: false },
        { hash: "0xbbb", isV2: false },
      ]);

      // Should have made exactly 1 batch request
      expect(fetchCount).toBe(1);

      // Now fetching individually should NOT make additional requests
      const resultA = await fetchAaveSubgraphData("test-key", 1, "0xaaa", false);
      const resultB = await fetchAaveSubgraphData("test-key", 1, "0xbbb", false);

      expect(fetchCount).toBe(1); // still 1 — cache hit
      expect(resultA).not.toBeNull();
      expect(resultA!.supply_apy).toBeDefined();
      expect(resultB).not.toBeNull();
      expect(resultB!.borrow_apy).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caches null for hashes with no events", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          data: {
            tx0_supplies: [],
            tx0_borrows: [],
            tx0_redeemUnderlyings: [],
            tx0_repays: [],
            tx0_liquidationCalls: [],
          },
        }),
      };
    });

    try {
      await prefetchAaveSubgraphBatch("test-key", 1, [
        { hash: "0xccc", isV2: false },
      ]);

      const result = await fetchAaveSubgraphData("test-key", 1, "0xccc", false);
      expect(result).toBeNull();
      expect(fetchCount).toBe(1); // no extra fetch for cached null
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips already-cached entries", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          data: {
            tx0_supplies: [{ amount: "1000", assetPriceUSD: "1.00", reserve: MOCK_RESERVE }],
            tx0_borrows: [],
            tx0_redeemUnderlyings: [],
            tx0_repays: [],
            tx0_liquidationCalls: [],
          },
        }),
      };
    });

    try {
      // First batch
      await prefetchAaveSubgraphBatch("test-key", 1, [
        { hash: "0xddd", isV2: false },
      ]);
      expect(fetchCount).toBe(1);

      // Second batch with same hash — should skip
      await prefetchAaveSubgraphBatch("test-key", 1, [
        { hash: "0xddd", isV2: false },
      ]);
      expect(fetchCount).toBe(1); // no additional fetch
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
