import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup, Erc20Tx } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import {
  mergeItemAccums,
  analyzeErc20Flows,
  buildAllGroupItems,
  resolveToLineItems,
  buildGroupDescription,
  buildHandlerEntry,
  formatTokenAmount,
  remapCounterpartyAccounts,
  type ItemAccum,
} from "./item-builder.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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
    value: "1000000000000000000", // 1e18 = 1 token
    contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
    tokenName: "TestToken",
    tokenSymbol: "TEST",
    tokenDecimal: "18",
    ...overrides,
  };
}

describe("mergeItemAccums", () => {
  it("merges items with same account and currency", () => {
    const items: ItemAccum[] = [
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("1.5") },
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("0.5") },
    ];
    const merged = mergeItemAccums(items);
    expect(merged).toHaveLength(1);
    expect(merged[0].account).toBe("Assets:Wallet");
    expect(merged[0].amount.toString()).toBe("2");
  });

  it("keeps items with different currencies separate", () => {
    const items: ItemAccum[] = [
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("1") },
      { account: "Assets:Wallet", currency: "USDC", amount: new Decimal("100") },
    ];
    const merged = mergeItemAccums(items);
    expect(merged).toHaveLength(2);
  });

  it("drops zero-sum items", () => {
    const items: ItemAccum[] = [
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("1") },
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("-1") },
    ];
    const merged = mergeItemAccums(items);
    expect(merged).toHaveLength(0);
  });

  it("handles empty input", () => {
    expect(mergeItemAccums([])).toHaveLength(0);
  });
});

describe("analyzeErc20Flows", () => {
  it("identifies inflow", () => {
    const flows = analyzeErc20Flows([makeErc20()], USER_ADDR);
    expect(flows).toHaveLength(1);
    expect(flows[0].direction).toBe("in");
    expect(flows[0].symbol).toBe("TEST");
    expect(flows[0].isMint).toBe(false);
    expect(flows[0].isBurn).toBe(false);
  });

  it("identifies outflow", () => {
    const flows = analyzeErc20Flows(
      [makeErc20({ from: USER_ADDR, to: OTHER_ADDR })],
      USER_ADDR,
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].direction).toBe("out");
  });

  it("identifies mint (from zero address)", () => {
    const flows = analyzeErc20Flows(
      [makeErc20({ from: ZERO_ADDRESS, to: USER_ADDR })],
      USER_ADDR,
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].isMint).toBe(true);
    expect(flows[0].isBurn).toBe(false);
  });

  it("identifies burn (to zero address)", () => {
    const flows = analyzeErc20Flows(
      [makeErc20({ from: USER_ADDR, to: ZERO_ADDRESS })],
      USER_ADDR,
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].isMint).toBe(false);
    expect(flows[0].isBurn).toBe(true);
  });

  it("skips zero-value transfers", () => {
    const flows = analyzeErc20Flows(
      [makeErc20({ value: "0" })],
      USER_ADDR,
    );
    expect(flows).toHaveLength(0);
  });

  it("skips self-transfers", () => {
    const flows = analyzeErc20Flows(
      [makeErc20({ from: USER_ADDR, to: USER_ADDR })],
      USER_ADDR,
    );
    expect(flows).toHaveLength(0);
  });
});

describe("buildAllGroupItems + resolveToLineItems", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
  });

  it("builds items from a normal ETH send", async () => {
    const group = makeEmptyGroup({
      normal: {
        hash: "0x1234567890abcdef",
        timeStamp: "1704067200",
        from: USER_ADDR,
        to: OTHER_ADDR,
        value: "1000000000000000000", // 1 ETH
        isError: "0",
        gasUsed: "21000",
        gasPrice: "20000000000", // 20 gwei
      },
    });

    const items = await buildAllGroupItems(group, USER_ADDR, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(items);
    expect(merged.length).toBeGreaterThan(0);

    // Items should balance to zero per currency
    const sums = new Map<string, Decimal>();
    for (const item of merged) {
      const existing = sums.get(item.currency) ?? new Decimal(0);
      sums.set(item.currency, existing.plus(item.amount));
    }
    for (const [, sum] of sums) {
      expect(sum.isZero()).toBe(true);
    }
  });

  it("builds and resolves ERC20 transfer items", async () => {
    const group = makeEmptyGroup({
      erc20s: [makeErc20()],
    });

    const items = await buildAllGroupItems(group, USER_ADDR, ctx.chain, ctx.label, ctx);
    const merged = mergeItemAccums(items);
    expect(merged.length).toBe(2); // our account + external account

    const lineItems = await resolveToLineItems(merged, "2024-01-01", ctx);
    expect(lineItems.length).toBe(2);

    // Each line item has an account_id and amount
    for (const li of lineItems) {
      expect(li.account_id).toBeTruthy();
      expect(li.currency).toBe("TEST");
    }

    // Amounts balance
    const total = lineItems.reduce(
      (sum, li) => sum.plus(new Decimal(li.amount)),
      new Decimal(0),
    );
    expect(total.isZero()).toBe(true);
  });
});

describe("buildGroupDescription", () => {
  const chain = { chain_id: 1, name: "Ethereum", native_currency: "ETH", decimals: 18 };

  it("describes a normal ETH send", () => {
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
    const desc = buildGroupDescription(group, USER_ADDR, chain);
    expect(desc).toContain("Send ETH to");
  });

  it("describes token-only transfer", () => {
    const group = makeEmptyGroup({
      erc20s: [makeErc20({ from: USER_ADDR, to: OTHER_ADDR })],
    });
    const desc = buildGroupDescription(group, USER_ADDR, chain);
    expect(desc).toContain("Send TEST to");
  });

  it("adds token count for normal + tokens", () => {
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
      erc20s: [makeErc20()],
    });
    const desc = buildGroupDescription(group, USER_ADDR, chain);
    expect(desc).toContain("1 tokens");
  });
});

describe("buildHandlerEntry", () => {
  it("creates a well-formed entry", () => {
    const entry = buildHandlerEntry({
      date: "2024-01-01",
      description: "Test",
      chainId: 1,
      hash: "0xabc",
      items: [],
      metadata: { handler: "test" },
    });
    expect(entry.entry.date).toBe("2024-01-01");
    expect(entry.entry.source).toBe("etherscan:1:0xabc");
    expect(entry.entry.status).toBe("confirmed");
    expect(entry.metadata.handler).toBe("test");
  });
});

describe("formatTokenAmount", () => {
  it("formats with trimmed trailing zeros", () => {
    expect(formatTokenAmount(new Decimal("1.5"), "ETH")).toBe("1.5 ETH");
    expect(formatTokenAmount(new Decimal("100"), "USDC")).toBe("100 USDC");
    expect(formatTokenAmount(new Decimal("0.00000001"), "WBTC")).toBe("0.00000001 WBTC");
  });
});

describe("remapCounterpartyAccounts", () => {
  it("remaps Equity:*:External:* wildcard pattern", () => {
    const items: ItemAccum[] = [
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("1") },
      { account: "Equity:Crypto:Wallet:Ethereum:External:0xabc", currency: "ETH", amount: new Decimal("-1") },
    ];
    const result = remapCounterpartyAccounts(items, [
      { from: "Equity:*:External:*", to: "Income:Crypto:DeFi:Aave:Rewards" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].account).toBe("Assets:Wallet");
    expect(result[1].account).toBe("Income:Crypto:DeFi:Aave:Rewards");
  });

  it("does not remap non-matching accounts", () => {
    const items: ItemAccum[] = [
      { account: "Assets:Wallet", currency: "ETH", amount: new Decimal("1") },
      { account: "Expenses:Gas", currency: "ETH", amount: new Decimal("-0.01") },
    ];
    const result = remapCounterpartyAccounts(items, [
      { from: "Equity:*:External:*", to: "Liabilities:Crypto:DeFi:Aave:Borrow" },
    ]);
    expect(result[0].account).toBe("Assets:Wallet");
    expect(result[1].account).toBe("Expenses:Gas");
  });

  it("supports exact match pattern", () => {
    const items: ItemAccum[] = [
      { account: "Equity:Trading:ETH", currency: "ETH", amount: new Decimal("1") },
    ];
    const result = remapCounterpartyAccounts(items, [
      { from: "Equity:Trading:ETH", to: "Income:Trading:ETH" },
    ]);
    expect(result[0].account).toBe("Income:Trading:ETH");
  });

  it("applies first matching remap only", () => {
    const items: ItemAccum[] = [
      { account: "Equity:Crypto:Wallet:Ethereum:External:0xabc", currency: "ETH", amount: new Decimal("-1") },
    ];
    const result = remapCounterpartyAccounts(items, [
      { from: "Equity:*:External:*", to: "Income:First" },
      { from: "Equity:*:External:*", to: "Income:Second" },
    ]);
    expect(result[0].account).toBe("Income:First");
  });

  it("preserves amount and currency", () => {
    const items: ItemAccum[] = [
      { account: "Equity:Crypto:Wallet:Ethereum:External:0xabc", currency: "USDC", amount: new Decimal("42.5") },
    ];
    const result = remapCounterpartyAccounts(items, [
      { from: "Equity:*:External:*", to: "Liabilities:Compound:Borrow" },
    ]);
    expect(result[0].currency).toBe("USDC");
    expect(result[0].amount.toString()).toBe("42.5");
  });

  it("handles empty items", () => {
    const result = remapCounterpartyAccounts([], [
      { from: "Equity:*:External:*", to: "Income:Test" },
    ]);
    expect(result).toHaveLength(0);
  });

  it("handles empty remaps", () => {
    const items: ItemAccum[] = [
      { account: "Equity:Crypto:Wallet:Ethereum:External:0xabc", currency: "ETH", amount: new Decimal("1") },
    ];
    const result = remapCounterpartyAccounts(items, []);
    expect(result[0].account).toBe("Equity:Crypto:Wallet:Ethereum:External:0xabc");
  });
});
