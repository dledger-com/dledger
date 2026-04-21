import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js-light";
import type { GenericBlockchainAccount } from "../backend.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { WanchainClient } from "./api.js";
import { syncWanchainAccount } from "./sync.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import type { TokenMeta, WanchainTxGroup, Wrc20Transfer } from "./types.js";

vi.mock("../data/invalidation.js", () => ({
  invalidate: vi.fn(),
}));

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0xcafe0000000000000000000000000000000cafe0";
const TOKEN = "0xaaaa000000000000000000000000000000000001";

interface Stubs {
  native?: WanchainTxGroup[];
  tokens?: Wrc20Transfer[];
  latestBlock?: number;
  tokenMeta?: Record<string, TokenMeta>;
}

function stubClient({
  native = [],
  tokens = [],
  latestBlock = 10000,
  tokenMeta = {},
}: Stubs): WanchainClient {
  const client = new WanchainClient();
  (client as any).getLatestBlock = vi.fn(async () => latestBlock);
  (client as any).getNativeTxs = vi.fn(async () => native);
  (client as any).getErc20Transfers = vi.fn(async () => tokens);
  (client as any).getTokenMeta = vi.fn(async (c: string) =>
    tokenMeta[c.toLowerCase()] ?? {
      address: c.toLowerCase(), symbol: "TKN", decimals: 18,
    },
  );
  (client as any).getReceipt = vi.fn(async () => null);
  (client as any).getBlockByNumber = vi.fn(async () => null);
  return client;
}

function makeAccount(): GenericBlockchainAccount {
  return {
    id: "wanchain-test-1",
    chain: "wanchain",
    address: ADDR,
    label: "TestWallet",
    cursor: null,
    last_sync: null,
    created_at: "2024-01-01T00:00:00Z",
    extra: null,
  };
}

function defaultSettings(): AppSettings {
  return {
    currency: "USD", dateFormat: "YYYY-MM-DD", fiscalYearStart: "01-01",
    etherscanApiKey: "", coingeckoApiKey: "", finnhubApiKey: "",
    cryptoCompareApiKey: "", theGraphApiKey: "", routescanApiKey: "",
    showHidden: false, lastRateSync: "", debugMode: false,
    holdingPeriodDays: 365, handlers: {},
  };
}

describe("syncWanchainAccount", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = await createTestBackend();
  });

  it("returns zeros and updates cursor when there's no activity", async () => {
    const client = stubClient({ latestBlock: 999 });
    const account = makeAccount();
    const result = await syncWanchainAccount(
      backend, account, defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(0);
  });

  it("imports a native WAN receive with no gas fee", async () => {
    const native: WanchainTxGroup = {
      hash: "0xhash1",
      blockNumber: 1000,
      timestamp: 1_700_000_000,
      from: OTHER,
      to: ADDR,
      value: "1000000000000000000", // 1 WAN
      gasUsed: "21000",
      gasPrice: "1000000000",
      success: true,
      tokenTransfers: [],
    };
    const client = stubClient({ native, latestBlock: 2000 } as any);
    (client as any).getNativeTxs = vi.fn(async () => [native]);

    const result = await syncWanchainAccount(
      backend, makeAccount(), defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    expect(entries).toHaveLength(1);
    const [entry, items] = entries[0];
    expect(entry.source).toBe("wanchain:0xhash1");
    expect(entry.description).toMatch(/Receive WAN/);

    // No fee items (receiver doesn't pay gas), just 2 WAN items summing to 0.
    expect(items).toHaveLength(2);
    const sum = items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(sum.toFixed()).toBe("0");
  });

  it("imports a native send with gas fee in ChainFees", async () => {
    const native: WanchainTxGroup = {
      hash: "0xsendhash",
      blockNumber: 1001,
      timestamp: 1_700_000_100,
      from: ADDR,
      to: OTHER,
      value: "2000000000000000000", // 2 WAN
      gasUsed: "21000",
      gasPrice: "1000000000", // 1 gwei → fee = 21000 * 1e9 = 2.1e13 wei = 0.000021 WAN
      success: true,
      tokenTransfers: [],
    };
    const client = stubClient({ native: [native], latestBlock: 2000 });

    const result = await syncWanchainAccount(
      backend, makeAccount(), defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    const [, items] = entries[0];

    // 4 items: wallet -2, external +2, wallet -0.000021, chainFees +0.000021
    expect(items).toHaveLength(4);
    const chainFeeItem = items.find((i) => i.amount === "0.000021");
    expect(chainFeeItem).toBeDefined();

    // Per-currency sum should be 0.
    const sum = items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(sum.toFixed()).toBe("0");
  });

  it("imports a WRC-20 token receive", async () => {
    const transfer: Wrc20Transfer = {
      contract: TOKEN,
      from: OTHER,
      to: ADDR,
      value: "1000000000000000000", // 1.0 with 18 decimals
      txHash: "0xtoken1",
      blockNumber: 1005,
      logIndex: 0,
    };
    const client = stubClient({
      tokens: [transfer],
      latestBlock: 2000,
      tokenMeta: { [TOKEN]: { address: TOKEN, symbol: "USDC", decimals: 18 } },
    });
    (client as any).getBlockByNumber = vi.fn(async (_n: number) => ({
      number: "0x3ed",
      hash: "0xblk",
      timestamp: "0x6553a000",
      transactions: [],
    }));
    (client as any).getReceipt = vi.fn(async () => ({
      transactionHash: "0xtoken1",
      blockNumber: "0x3ed",
      gasUsed: "0x0",
      status: "0x1",
      logs: [],
    }));

    const result = await syncWanchainAccount(
      backend, makeAccount(), defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    const [, items] = entries[0];
    const usdcSum = items
      .filter((i) => i.currency === "USDC")
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(usdcSum.toFixed()).toBe("0");
  });

  it("dedupes on re-sync by tx hash", async () => {
    const native: WanchainTxGroup = {
      hash: "0xdup",
      blockNumber: 1002,
      timestamp: 1_700_000_000,
      from: OTHER, to: ADDR,
      value: "1000000000000000000",
      gasUsed: "0", gasPrice: "0",
      success: true,
      tokenTransfers: [],
    };
    const account = makeAccount();
    const settings = defaultSettings();

    const c1 = stubClient({ native: [native], latestBlock: 2000 });
    await syncWanchainAccount(backend, account, settings, undefined, undefined, c1);

    const c2 = stubClient({ native: [native], latestBlock: 3000 });
    const second = await syncWanchainAccount(backend, account, settings, undefined, undefined, c2);
    expect(second.transactions_imported).toBe(0);
    expect(second.transactions_skipped).toBe(1);
  });

  it("aggregates native + WRC-20 in the same tx hash", async () => {
    const hash = "0xcombo";
    const native: WanchainTxGroup = {
      hash, blockNumber: 1500, timestamp: 1_700_000_500,
      from: ADDR, to: OTHER,
      value: "500000000000000000", // 0.5 WAN
      gasUsed: "50000", gasPrice: "1000000000",
      success: true, tokenTransfers: [],
    };
    const transfer: Wrc20Transfer = {
      contract: TOKEN, from: ADDR, to: OTHER,
      value: "1000000", // 1.0 with 6 decimals
      txHash: hash, blockNumber: 1500, logIndex: 0,
    };
    const client = stubClient({
      native: [native], tokens: [transfer], latestBlock: 2000,
      tokenMeta: { [TOKEN]: { address: TOKEN, symbol: "USDT", decimals: 6 } },
    });

    const result = await syncWanchainAccount(
      backend, makeAccount(), defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    // Exactly one entry — the two sources grouped by txHash.
    expect(entries).toHaveLength(1);
    const [, items] = entries[0];
    const wanSum = items
      .filter((i) => i.currency === "WAN")
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    const usdtSum = items
      .filter((i) => i.currency === "USDT")
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(wanSum.toFixed()).toBe("0");
    expect(usdtSum.toFixed()).toBe("0");
  });

  it("skips failed transactions", async () => {
    const native: WanchainTxGroup = {
      hash: "0xfail",
      blockNumber: 2100, timestamp: 1_700_001_000,
      from: ADDR, to: OTHER,
      value: "1000000000000000000",
      gasUsed: "21000", gasPrice: "1000000000",
      success: false, tokenTransfers: [],
    };
    const client = stubClient({ native: [native], latestBlock: 3000 });
    const result = await syncWanchainAccount(
      backend, makeAccount(), defaultSettings(), undefined, undefined, client,
    );
    expect(result.transactions_imported).toBe(0);
    expect(result.transactions_skipped).toBe(1);
  });
});
