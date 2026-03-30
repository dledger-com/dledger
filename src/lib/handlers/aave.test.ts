import { describe, it, expect, beforeEach, vi } from "vitest";
import Decimal from "decimal.js-light";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import type { JournalEntry, LineItem } from "../types/index.js";
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

/** Post a handler entry result to the backend so balances accumulate for subsequent tests */
async function postHandlerEntry(
  backend: SqlJsBackend,
  result: { type: string; entries?: { entry: Record<string, unknown>; items: Record<string, unknown>[] }[] },
): Promise<void> {
  if (result.type !== "entries" || !result.entries) return;
  for (const he of result.entries) {
    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId,
      date: he.entry.date as string,
      description: he.entry.description as string,
      status: (he.entry.status as "confirmed" | "pending" | "voided") || "confirmed",
      source: (he.entry.source as string) || "",
      voided_by: null,
      created_at: he.entry.date as string,
    };
    const items: LineItem[] = (he.items as { account_id: string; currency: string; amount: string; lot_id: string | null }[]).map((item, idx) => ({
      id: `${entryId}-li-${idx}`,
      journal_entry_id: entryId,
      account_id: item.account_id,
      currency: item.currency,
      amount: item.amount,
      lot_id: item.lot_id ?? null,
    }));
    await backend.postJournalEntry(entry, items);
  }
}

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

    it("returns 55 when normal.to is the Swap Collateral Adapter", () => {
      const group = makeEmptyGroup({
        normal: {
          hash: "0x1234567890abcdef",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: "0xADC0A53095a0af87F3aa29FE0715b5c28016364e",
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
      });
      expect(aaveHandler.match(group, ctx)).toBe(55);
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

      // Description includes "Supply" (no amounts/tokens in unified format)
      expect(entry.entry.description).toContain("Supply");

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
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
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
      expect(entry.metadata["handler:action"]).toBe("BORROW");

      // No variableDebtDAI in items — only real currencies
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("variableDebtDAI");
      expect(currencies).toContain("DAI");

      // Items should have Liabilities:Aave:Borrow account
      const accounts = await backend.listAccounts();
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Crypto:DeFi:Aave:Borrow");
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
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
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
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Crypto:DeFi:Aave:Borrow");
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
      const rewardAcct = accounts.find((a) => a.full_name === "Income:Crypto:DeFi:Aave:Rewards");
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
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");
      expect(entry.metadata["handler:version"]).toBe("V3");

      // No aEthWETH in items — only WETH
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWETH");
      expect(currencies).toContain("WETH");

      // Protocol items use WETH, not aEthWETH
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
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
      expect(entry.entry.description).toContain("Borrow");

      // Metadata has comma-joined actions
      expect(entry.metadata["handler:action"]).toContain("SUPPLY");
      expect(entry.metadata["handler:action"]).toContain("BORROW");

      // Has both protocol accounts
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Crypto:DeFi:Aave:Borrow");
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
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
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
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
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

    it("recognizes supply interest on withdrawal when prior supply exists", async () => {
      // Step 1: Process and post a SUPPLY of 1000 USDC
      const supplyGroup = makeEmptyGroup({
        hash: "0xaaaa000000000001",
        timestamp: "1704067200",
        normal: {
          hash: "0xaaaa000000000001",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xaaaa000000000001",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aUSDC",
            value: "1000000000", // 1000 USDC
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xaaaa000000000001",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "USDC",
            value: "1000000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const supplyResult = await aaveHandler.process(supplyGroup, ctx);
      expect(supplyResult.type).toBe("entries");
      await postHandlerEntry(backend, supplyResult);

      // Step 2: Process WITHDRAW of 1050 USDC (1000 principal + 50 interest)
      const withdrawGroup = makeEmptyGroup({
        hash: "0xbbbb000000000002",
        timestamp: "1704153600",
        normal: {
          hash: "0xbbbb000000000002",
          timeStamp: "1704153600",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xbbbb000000000002",
            timeStamp: "1704153600",
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "aUSDC",
            value: "1050000000", // 1050 USDC (principal + interest)
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xbbbb000000000002",
            timeStamp: "1704153600",
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            value: "1050000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const withdrawResult = await aaveHandler.process(withdrawGroup, ctx);
      expect(withdrawResult.type).toBe("entries");
      if (withdrawResult.type !== "entries") return;

      const entry = withdrawResult.entries[0];
      const accounts = await backend.listAccounts();

      // Income:Aave:Interest account should exist with -50 USDC (credit)
      const interestAcct = accounts.find((a) => a.full_name === "Income:Crypto:DeFi:Aave:Interest");
      expect(interestAcct).toBeDefined();
      const interestItem = entry.items.find((i) => i.account_id === interestAcct!.id);
      expect(interestItem).toBeDefined();
      expect(interestItem!.currency).toBe("USDC");
      expect(new Decimal(interestItem!.amount).toFixed(6)).toBe("-50.000000");

      // Assets:Aave:Supply should be -1000 (not -1050)
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(new Decimal(supplyItem!.amount).toFixed(6)).toBe("-1000.000000");

      // Metadata records interest earned
      expect(entry.metadata["handler:interest_earned_usdc"]).toBe("50");

      // Items still balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("recognizes borrow interest on repay when prior borrow exists", async () => {
      // Step 1: Process and post a BORROW of 500 DAI
      const borrowGroup = makeEmptyGroup({
        hash: "0xcccc000000000001",
        timestamp: "1704067200",
        normal: {
          hash: "0xcccc000000000001",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "250000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xcccc000000000001",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtDAI",
            value: "500000000000000000000", // 500 DAI
            tokenDecimal: "18",
            contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
          }),
          makeErc20({
            hash: "0xcccc000000000001",
            timeStamp: "1704067200",
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "DAI",
            value: "500000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          }),
        ],
      });

      const borrowResult = await aaveHandler.process(borrowGroup, ctx);
      expect(borrowResult.type).toBe("entries");
      await postHandlerEntry(backend, borrowResult);

      // Step 2: Process REPAY of 515 DAI (500 principal + 15 interest)
      const repayGroup = makeEmptyGroup({
        hash: "0xdddd000000000002",
        timestamp: "1704153600",
        normal: {
          hash: "0xdddd000000000002",
          timeStamp: "1704153600",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xdddd000000000002",
            timeStamp: "1704153600",
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "variableDebtDAI",
            value: "515000000000000000000", // 515 DAI
            tokenDecimal: "18",
            contractAddress: "0xdddddddddddddddddddddddddddddddddddddd",
          }),
          makeErc20({
            hash: "0xdddd000000000002",
            timeStamp: "1704153600",
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "DAI",
            value: "515000000000000000000",
            tokenDecimal: "18",
            contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          }),
        ],
      });

      const repayResult = await aaveHandler.process(repayGroup, ctx);
      expect(repayResult.type).toBe("entries");
      if (repayResult.type !== "entries") return;

      const entry = repayResult.entries[0];
      const accounts = await backend.listAccounts();

      // Expenses:Aave:Interest should exist with +15 DAI (debit = expense)
      const interestAcct = accounts.find((a) => a.full_name === "Expenses:Crypto:DeFi:Aave:Interest");
      expect(interestAcct).toBeDefined();
      const interestItem = entry.items.find((i) => i.account_id === interestAcct!.id);
      expect(interestItem).toBeDefined();
      expect(interestItem!.currency).toBe("DAI");
      expect(new Decimal(interestItem!.amount).toFixed(0)).toBe("15");

      // Liabilities:Aave:Borrow should be +500 (not +515)
      const borrowAcct = accounts.find((a) => a.full_name === "Liabilities:Crypto:DeFi:Aave:Borrow");
      const borrowItem = entry.items.find((i) => i.account_id === borrowAcct!.id);
      expect(borrowItem).toBeDefined();
      expect(new Decimal(borrowItem!.amount).toFixed(0)).toBe("500");

      // Metadata records interest paid
      expect(entry.metadata["handler:interest_paid_dai"]).toBe("15");

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

    it("cold start: no interest recognized when no prior supply exists", async () => {
      // Withdraw without any prior supply in the backend
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
          makeErc20({
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "aUSDC",
            value: "1050000000", // 1050 USDC
            tokenDecimal: "6",
          }),
          makeErc20({
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            value: "1050000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      const accounts = await backend.listAccounts();

      // No Income:Aave:Interest account should exist (cold start guard)
      const interestAcct = accounts.find((a) => a.full_name === "Income:Crypto:DeFi:Aave:Interest");
      expect(interestAcct).toBeUndefined();

      // Full amount goes to Assets:Aave:Supply
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(new Decimal(supplyItem!.amount).toFixed(6)).toBe("-1050.000000");

      // No interest metadata
      expect(entry.metadata["handler:interest_earned_usdc"]).toBeUndefined();
    });

    it("partial withdrawal: no interest when amount <= supply balance", async () => {
      // Supply 2000 USDC first
      const supplyGroup = makeEmptyGroup({
        hash: "0xeeee000000000001",
        timestamp: "1704067200",
        normal: {
          hash: "0xeeee000000000001",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xeeee000000000001",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aUSDC",
            value: "2000000000", // 2000 USDC
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xeeee000000000001",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: AAVE_POOL,
            tokenSymbol: "USDC",
            value: "2000000000",
            tokenDecimal: "6",
          }),
        ],
      });
      const supplyResult = await aaveHandler.process(supplyGroup, ctx);
      await postHandlerEntry(backend, supplyResult);

      // Withdraw 1000 USDC (less than 2000 balance → no interest)
      const withdrawGroup = makeEmptyGroup({
        hash: "0xffff000000000002",
        timestamp: "1704153600",
        normal: {
          hash: "0xffff000000000002",
          timeStamp: "1704153600",
          from: USER_ADDR,
          to: AAVE_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xffff000000000002",
            timeStamp: "1704153600",
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "aUSDC",
            value: "1000000000", // 1000 USDC
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xffff000000000002",
            timeStamp: "1704153600",
            from: AAVE_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            value: "1000000000",
            tokenDecimal: "6",
          }),
        ],
      });

      const result = await aaveHandler.process(withdrawGroup, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];
      const accounts = await backend.listAccounts();

      // No Income:Aave:Interest account (no interest detected)
      const interestAcct = accounts.find((a) => a.full_name === "Income:Crypto:DeFi:Aave:Interest");
      expect(interestAcct).toBeUndefined();

      // Full withdrawal amount goes to Assets:Aave:Supply
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(new Decimal(supplyItem!.amount).toFixed(6)).toBe("-1000.000000");

      // Description does NOT mention interest
      expect(entry.entry.description).not.toContain("interest");
    });

    it("uses underlying transfer amount when aToken amount differs (liquidity index scaling)", async () => {
      // Reproduces the tBTC scenario: aEthtBTC mint amount (10.097) differs from
      // the actual tBTC transfer amount (10.092) due to Aave's liquidity index.
      // The handler should use the underlying transfer amount to ensure balance.
      const ATOKEN_CONTRACT = "0xa5ba6e5ec19a1bf23c857991c857db62b2aa187b"; // aEthtBTC
      const TBTC_CONTRACT = "0x18084fba666a33d37592fa2633fd49a74dd93a88";

      const group = makeEmptyGroup({
        normal: {
          hash: "0xae791cc000000000",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "300000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aEthtBTC minted: 10.097 (scaled by liquidity index)
          makeErc20({
            hash: "0xae791cc000000000",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthtBTC",
            tokenName: "Aave Ethereum tBTC",
            value: "10097000000000000000", // 10.097 tBTC (18 decimals)
            tokenDecimal: "18",
            contractAddress: ATOKEN_CONTRACT,
          }),
          // tBTC transferred: 10.092 (actual underlying amount)
          makeErc20({
            hash: "0xae791cc000000000",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: ATOKEN_CONTRACT,
            tokenSymbol: "tBTC",
            tokenName: "tBTC v2",
            value: "10092000000000000000", // 10.092 tBTC (18 decimals)
            tokenDecimal: "18",
            contractAddress: TBTC_CONTRACT,
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      expect(result.entries).toHaveLength(1);
      const entry = result.entries[0];

      // Description should mention Supply
      expect(entry.entry.description).toContain("Supply");

      // No aEthtBTC in items — only real tBTC
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthtBTC");
      expect(currencies).toContain("tBTC");

      // Assets:Aave:Supply should use the underlying amount (10.092), not aToken amount (10.097)
      const accounts = await backend.listAccounts();
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItem = entry.items.find((i) => i.account_id === supplyAcct!.id);
      expect(supplyItem).toBeDefined();
      expect(supplyItem!.currency).toBe("tBTC");
      expect(new Decimal(supplyItem!.amount).toFixed(3)).toBe("10.092");

      // Items must balance to zero per currency (this is the key assertion —
      // using the aToken amount would leave a +0.005 tBTC imbalance)
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles collateral swap via adapter: adapter burn skipped, Trading counterparty for new mint", async () => {
      // Pattern A: Swap Collateral Adapter swaps one aToken for another.
      // ERC20 pattern: rebase aToken mint (tiny, from 0x0 to user), aToken burn by adapter
      // (from adapter to 0x0), underlying flows through adapter/DEX (never touch user),
      // new aToken minted to user.
      const ADAPTER = "0xadc0a53095a0af87f3aa29fe0715b5c28016364e";
      const DEX = "0xdef1def1def1def1def1def1def1def1def1def1";

      const group = makeEmptyGroup({
        normal: {
          hash: "0xcollateral_swap",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ADAPTER,
          value: "0",
          isError: "0",
          gasUsed: "500000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // 1. Rebase mint: tiny aEthWBTC minted to user (interest accrual artifact)
          makeErc20({
            hash: "0xcollateral_swap",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthWBTC",
            tokenName: "Aave Ethereum WBTC",
            value: "100000", // 0.001 WBTC (8 decimals)
            tokenDecimal: "8",
          }),
          // 2. Adapter burns aEthWBTC (from adapter, not user)
          makeErc20({
            hash: "0xcollateral_swap",
            timeStamp: "1704067200",
            from: ADAPTER,
            to: ZERO_ADDRESS,
            tokenSymbol: "aEthWBTC",
            tokenName: "Aave Ethereum WBTC",
            value: "100000000", // 1.0 WBTC
            tokenDecimal: "8",
          }),
          // 3. WBTC flows: adapter → DEX (not touching user)
          makeErc20({
            hash: "0xcollateral_swap",
            timeStamp: "1704067200",
            from: ADAPTER,
            to: DEX,
            tokenSymbol: "WBTC",
            tokenName: "Wrapped BTC",
            value: "100000000", // 1.0 WBTC
            tokenDecimal: "8",
          }),
          // 4. tBTC flows: DEX → adapter (not touching user)
          makeErc20({
            hash: "0xcollateral_swap",
            timeStamp: "1704067200",
            from: DEX,
            to: ADAPTER,
            tokenSymbol: "tBTC",
            tokenName: "tBTC v2",
            value: "990000000000000000", // 0.99 tBTC (18 decimals)
            tokenDecimal: "18",
          }),
          // 5. New aEthtBTC minted to user (the new collateral position)
          makeErc20({
            hash: "0xcollateral_swap",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthtBTC",
            tokenName: "Aave Ethereum tBTC",
            value: "990000000000000000", // 0.99 tBTC
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Should have Supply actions for both mints
      expect(entry.entry.description).toContain("Supply");
      expect(entry.metadata["handler:action"]).toContain("SUPPLY");

      // No aToken symbols in items
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthWBTC");
      expect(currencies).not.toContain("aEthtBTC");

      // Should have Equity:Trading counterparties (no wallet-side underlying flows)
      const accounts = await backend.listAccounts();
      const tradingAccts = accounts.filter((a) => a.full_name.startsWith("Equity:Trading:"));
      expect(tradingAccts.length).toBeGreaterThanOrEqual(1);

      // Items must balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles flash loan supply: aToken minted with no underlying transfer → Trading counterparty", async () => {
      // Pattern B: Flash loan supply. aToken minted to user but underlying
      // flows entirely through adapter/pool — no wallet-side counterparty.
      const group = makeEmptyGroup({
        normal: {
          hash: "0xflash_loan_supply",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "400000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // aEthtBTC minted to user (new supply position from flash loan)
          makeErc20({
            hash: "0xflash_loan_supply",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthtBTC",
            tokenName: "Aave Ethereum tBTC",
            value: "5000000000000000000", // 5.0 tBTC
            tokenDecimal: "18",
          }),
          // tBTC flows through pool internally — never from/to user
          makeErc20({
            hash: "0xflash_loan_supply",
            timeStamp: "1704067200",
            from: AAVE_V3_POOL,
            to: OTHER_ADDR,
            tokenSymbol: "tBTC",
            tokenName: "tBTC v2",
            value: "5000000000000000000",
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Should have SUPPLY action
      expect(entry.entry.description).toContain("Supply");
      expect(entry.metadata["handler:action"]).toBe("SUPPLY");

      // No aEthtBTC in items
      const currencies = entry.items.map((i) => i.currency);
      expect(currencies).not.toContain("aEthtBTC");
      expect(currencies).toContain("tBTC");

      // Should have Equity:Trading:tBTC counterparty
      const accounts = await backend.listAccounts();
      const tradingAcct = accounts.find((a) => a.full_name === "Equity:Trading:tBTC");
      expect(tradingAcct).toBeDefined();

      // Items must balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [, sum] of sums) {
        expect(sum.isZero()).toBe(true);
      }
    });

    it("handles repay with collateral: debtToken burned with no underlying wallet flow → Trading counterparty", async () => {
      // Pattern: CoW Protocol adapter sells collateral (aEthtBTC) to get USDC,
      // which repays USDC variable debt. The underlying USDC never touches user wallet.
      // ERC20s: debtToken burn + tiny aToken rebase mint + aToken transfer out + tBTC change in.
      const ADAPTER = "0x29e3000000000000000000000000000000000000";

      // First, set up prior borrow balance of 350,000 USDC
      const borrowGroup = makeEmptyGroup({
        hash: "0xsetup_borrow_001",
        timestamp: "1704000000",
        normal: {
          hash: "0xsetup_borrow_001",
          timeStamp: "1704000000",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xsetup_borrow_001",
            timeStamp: "1704000000",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtEthUSDC",
            value: "350000000000", // 350,000 USDC (6 decimals)
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xsetup_borrow_001",
            timeStamp: "1704000000",
            from: AAVE_V3_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            value: "350000000000",
            tokenDecimal: "6",
          }),
        ],
      });
      const borrowResult = await aaveHandler.process(borrowGroup, ctx);
      expect(borrowResult.type).toBe("entries");
      await postHandlerEntry(backend, borrowResult);

      // Also set up prior tBTC supply
      const supplyGroup = makeEmptyGroup({
        hash: "0xsetup_supply_001",
        timestamp: "1704000000",
        normal: {
          hash: "0xsetup_supply_001",
          timeStamp: "1704000000",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xsetup_supply_001",
            timeStamp: "1704000000",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthtBTC",
            value: "5000000000000000000", // 5.0 tBTC
            tokenDecimal: "18",
          }),
          makeErc20({
            hash: "0xsetup_supply_001",
            timeStamp: "1704000000",
            from: USER_ADDR,
            to: AAVE_V3_POOL,
            tokenSymbol: "tBTC",
            value: "5000000000000000000",
            tokenDecimal: "18",
          }),
        ],
      });
      const supplyResult = await aaveHandler.process(supplyGroup, ctx);
      expect(supplyResult.type).toBe("entries");
      await postHandlerEntry(backend, supplyResult);

      // Now: Repay with Collateral transaction
      const group = makeEmptyGroup({
        hash: "0xbc8d0cdbd8af99b1",
        timestamp: "1704067200",
        normal: null, // CoW solver sent the tx, not user
        erc20s: [
          // 1. variableDebtEthUSDC burn: 348,468 USDC debt repaid
          makeErc20({
            hash: "0xbc8d0cdbd8af99b1",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "variableDebtEthUSDC",
            tokenName: "Aave variable debt USDC",
            value: "348468000000", // 348,468 USDC (6 decimals)
            tokenDecimal: "6",
          }),
          // 2. aEthtBTC rebase mint: tiny amount (interest accrual artifact)
          makeErc20({
            hash: "0xbc8d0cdbd8af99b1",
            timeStamp: "1704067200",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthtBTC",
            tokenName: "Aave Ethereum tBTC",
            value: "39000000000000", // 0.000039 tBTC (18 decimals)
            tokenDecimal: "18",
          }),
          // 3. aEthtBTC transfer: user → adapter (collateral sent to be sold)
          makeErc20({
            hash: "0xbc8d0cdbd8af99b1",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: ADAPTER,
            tokenSymbol: "aEthtBTC",
            tokenName: "Aave Ethereum tBTC",
            value: "4947000000000000000", // 4.947 tBTC
            tokenDecimal: "18",
          }),
          // 4. tBTC: adapter → user (change returned)
          makeErc20({
            hash: "0xbc8d0cdbd8af99b1",
            timeStamp: "1704067200",
            from: ADAPTER,
            to: USER_ADDR,
            tokenSymbol: "tBTC",
            tokenName: "tBTC v2",
            value: "77000000000000000", // 0.077 tBTC
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Description should include "Repay with Collateral"
      expect(entry.entry.description).toContain("Repay with Collateral");

      // Action metadata should contain REPAY
      expect(entry.metadata["handler:action"]).toContain("REPAY");

      // Should have Equity:Trading:USDC counterparty (since USDC never touched user wallet)
      const accounts = await backend.listAccounts();
      const tradingUSDC = accounts.find((a) => a.full_name === "Equity:Trading:USDC");
      expect(tradingUSDC).toBeDefined();

      // Collateral side should use Equity:Trading:tBTC (not External)
      const tradingTBTC = accounts.find((a) => a.full_name === "Equity:Trading:tBTC");
      expect(tradingTBTC).toBeDefined();

      // Items must balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [currency, sum] of sums) {
        expect(sum.isZero(), `${currency} should balance to zero but got ${sum.toString()}`).toBe(true);
      }
    });

    it("handles repay with collateral Pattern B: adapter burns aTokens on behalf of user", async () => {
      // Pattern B: Adapter handles aTokens entirely — pool → adapter → burn.
      // User never touches aTokens. debtToken burned by user.
      // Expected: Assets:Aave:Supply decreases, Equity:Trading for cross-currency bridge.
      const ADAPTER = "0xadc0a53095a0af87f3aa29fe0715b5c28016364e";

      // Setup: prior wstETH supply of 10.0
      const supplyGroup = makeEmptyGroup({
        hash: "0xsetup_supply_002",
        timestamp: "1704000000",
        normal: {
          hash: "0xsetup_supply_002",
          timeStamp: "1704000000",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xsetup_supply_002",
            timeStamp: "1704000000",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "aEthwstETH",
            value: "10000000000000000000", // 10.0 wstETH
            tokenDecimal: "18",
          }),
          makeErc20({
            hash: "0xsetup_supply_002",
            timeStamp: "1704000000",
            from: USER_ADDR,
            to: AAVE_V3_POOL,
            tokenSymbol: "wstETH",
            value: "10000000000000000000",
            tokenDecimal: "18",
          }),
        ],
      });
      const supplyResult = await aaveHandler.process(supplyGroup, ctx);
      expect(supplyResult.type).toBe("entries");
      await postHandlerEntry(backend, supplyResult);

      // Setup: prior USDC borrow of 20,000
      const borrowGroup = makeEmptyGroup({
        hash: "0xsetup_borrow_002",
        timestamp: "1704000000",
        normal: {
          hash: "0xsetup_borrow_002",
          timeStamp: "1704000000",
          from: USER_ADDR,
          to: AAVE_V3_POOL,
          value: "0",
          isError: "0",
          gasUsed: "200000",
          gasPrice: "20000000000",
        },
        erc20s: [
          makeErc20({
            hash: "0xsetup_borrow_002",
            timeStamp: "1704000000",
            from: ZERO_ADDRESS,
            to: USER_ADDR,
            tokenSymbol: "variableDebtEthUSDC",
            value: "20000000000", // 20,000 USDC
            tokenDecimal: "6",
          }),
          makeErc20({
            hash: "0xsetup_borrow_002",
            timeStamp: "1704000000",
            from: AAVE_V3_POOL,
            to: USER_ADDR,
            tokenSymbol: "USDC",
            value: "20000000000",
            tokenDecimal: "6",
          }),
        ],
      });
      const borrowResult = await aaveHandler.process(borrowGroup, ctx);
      expect(borrowResult.type).toBe("entries");
      await postHandlerEntry(backend, borrowResult);

      // Pattern B transaction: adapter handles aTokens entirely
      const group = makeEmptyGroup({
        hash: "0xa4e785bb00000001",
        timestamp: "1704067200",
        normal: {
          hash: "0xa4e785bb00000001",
          timeStamp: "1704067200",
          from: USER_ADDR,
          to: ADAPTER,
          value: "0",
          isError: "0",
          gasUsed: "500000",
          gasPrice: "20000000000",
        },
        erc20s: [
          // 1. aEthwstETH: pool → adapter (intermediate, user never touches)
          makeErc20({
            hash: "0xa4e785bb00000001",
            timeStamp: "1704067200",
            from: AAVE_V3_POOL,
            to: ADAPTER,
            tokenSymbol: "aEthwstETH",
            tokenName: "Aave Ethereum wstETH",
            value: "8000000000000000000", // 8.0 wstETH
            tokenDecimal: "18",
          }),
          // 2. aEthwstETH: adapter → 0x0 (burn by adapter, not user)
          makeErc20({
            hash: "0xa4e785bb00000001",
            timeStamp: "1704067200",
            from: ADAPTER,
            to: ZERO_ADDRESS,
            tokenSymbol: "aEthwstETH",
            tokenName: "Aave Ethereum wstETH",
            value: "8000000000000000000", // 8.0 wstETH
            tokenDecimal: "18",
          }),
          // 3. variableDebtEthUSDC: user → 0x0 (debt repaid)
          makeErc20({
            hash: "0xa4e785bb00000001",
            timeStamp: "1704067200",
            from: USER_ADDR,
            to: ZERO_ADDRESS,
            tokenSymbol: "variableDebtEthUSDC",
            tokenName: "Aave variable debt USDC",
            value: "18000000000", // 18,000 USDC
            tokenDecimal: "6",
          }),
          // 4. wstETH: adapter → user (small change returned)
          makeErc20({
            hash: "0xa4e785bb00000001",
            timeStamp: "1704067200",
            from: ADAPTER,
            to: USER_ADDR,
            tokenSymbol: "wstETH",
            tokenName: "Wrapped liquid staked Ether 2.0",
            value: "50000000000000000", // 0.05 wstETH change
            tokenDecimal: "18",
          }),
        ],
      });

      const result = await aaveHandler.process(group, ctx);
      expect(result.type).toBe("entries");
      if (result.type !== "entries") return;

      const entry = result.entries[0];

      // Description should include "Repay with Collateral"
      expect(entry.entry.description).toContain("Repay with Collateral");

      // Action metadata should contain REPAY
      expect(entry.metadata["handler:action"]).toContain("REPAY");

      // Should have Equity:Trading:wstETH (collateral side uses Trading, not External)
      const accounts = await backend.listAccounts();
      const tradingWstETH = accounts.find((a) => a.full_name === "Equity:Trading:wstETH");
      expect(tradingWstETH).toBeDefined();

      // Should have Equity:Trading:USDC (repay side uses Trading)
      const tradingUSDC = accounts.find((a) => a.full_name === "Equity:Trading:USDC");
      expect(tradingUSDC).toBeDefined();

      // Assets:Aave:Supply should decrease (adapter burn creates supply debit)
      const supplyAcct = accounts.find((a) => a.full_name === "Assets:Crypto:DeFi:Aave:Supply");
      expect(supplyAcct).toBeDefined();
      const supplyItems = entry.items.filter((i) => i.account_id === supplyAcct!.id);
      const supplyTotal = supplyItems.reduce((s, i) => s.plus(new Decimal(i.amount)), new Decimal(0));
      expect(supplyTotal.isNegative()).toBe(true);

      // Items must balance to zero per currency
      const sums = new Map<string, Decimal>();
      for (const item of entry.items) {
        const existing = sums.get(item.currency) ?? new Decimal(0);
        sums.set(item.currency, existing.plus(new Decimal(item.amount)));
      }
      for (const [currency, sum] of sums) {
        expect(sum.isZero(), `${currency} should balance to zero but got ${sum.toString()}`).toBe(true);
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
