import { describe, it, expect, beforeEach } from "vitest";
import { syncPluginChain } from "./blockchain-sync.js";
import { createTestBackend } from "../../test/helpers.js";
import type { Backend, GenericBlockchainAccount } from "../backend.js";
import type { BlockchainSourceExtension, BlockchainRawTransaction, BlockchainProcessContext } from "./types.js";

function makeAccount(overrides: Partial<GenericBlockchainAccount> = {}): GenericBlockchainAccount {
  return {
    id: "test-id",
    chain: "test-chain",
    address: "0x1234567890abcdef1234567890abcdef12345678",
    label: "MyWallet",
    cursor: null,
    last_sync: null,
    created_at: "2025-01-01",
    ...overrides,
  };
}

function makeExt(overrides: Partial<BlockchainSourceExtension> = {}): BlockchainSourceExtension {
  return {
    chainId: "test-chain",
    chainName: "TestChain",
    symbol: "TST",
    addressRegex: "^0x[a-f0-9]{40}$",
    addressPlaceholder: "0x...",
    fetchTransactions: async () => ({ transactions: [], nextCursor: null }),
    processTransaction: () => null,
    ...overrides,
  };
}

describe("syncPluginChain", () => {
  let backend: Backend;

  beforeEach(async () => {
    backend = await createTestBackend();
  });

  it("returns zero counts when there are no transactions", async () => {
    const result = await syncPluginChain(backend, makeExt(), makeAccount(), {});
    expect(result.transactions_imported).toBe(0);
    expect(result.transactions_skipped).toBe(0);
    expect(result.accounts_created).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("imports a simple transfer transaction", async () => {
    const ext = makeExt({
      fetchTransactions: async () => ({
        transactions: [{
          id: "tx1",
          timestamp: 1704067200,
          data: { type: "transfer", amount: "1000000000000000000", from: "0xaaaa", to: "0x1234567890abcdef1234567890abcdef12345678" },
        }],
        nextCursor: null,
      }),
      processTransaction: (tx: BlockchainRawTransaction, ctx: BlockchainProcessContext) => {
        const raw = tx.data as any;
        return {
          source: `test-chain:${tx.id}`,
          date: "2025-01-01",
          description: "Test transfer",
          items: [
            { account: `Assets:Crypto:Wallet:${ctx.chainName}:${ctx.label}`, currency: "TST", amount: "1" },
            { account: `Assets:Crypto:Wallet:${ctx.chainName}:External:0xaaaa`, currency: "TST", amount: "-1" },
          ],
          metadata: { "chain:txhash": tx.id },
        };
      },
    });

    const result = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result.transactions_imported).toBe(1);
    expect(result.transactions_skipped).toBe(0);
    expect(result.accounts_created).toBeGreaterThan(0);

    // Verify the journal entry was created
    const entries = await backend.queryJournalEntries({});
    const pluginEntries = entries.filter(([e]) => e.source.startsWith("test-chain:"));
    expect(pluginEntries).toHaveLength(1);
    expect(pluginEntries[0][0].description).toBe("Test transfer");
  });

  it("deduplicates transactions by source", async () => {
    const ext = makeExt({
      fetchTransactions: async () => ({
        transactions: [{ id: "tx1", timestamp: 1704067200, data: {} }],
        nextCursor: null,
      }),
      processTransaction: () => ({
        source: "test-chain:tx1",
        date: "2025-01-01",
        description: "Test",
        items: [
          { account: "Assets:Crypto:Wallet:TestChain:Mywallet", currency: "TST", amount: "1" },
          { account: "Assets:Crypto:Wallet:TestChain:External", currency: "TST", amount: "-1" },
        ],
      }),
    });

    // First sync
    const result1 = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result1.transactions_imported).toBe(1);

    // Second sync — same tx should be skipped
    const result2 = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result2.transactions_imported).toBe(0);
    expect(result2.transactions_skipped).toBe(1);
  });

  it("skips transactions when processTransaction returns null", async () => {
    const ext = makeExt({
      fetchTransactions: async () => ({
        transactions: [
          { id: "tx1", timestamp: 1704067200, data: { type: "unknown" } },
          { id: "tx2", timestamp: 1704067200, data: { type: "unknown" } },
        ],
        nextCursor: null,
      }),
      processTransaction: () => null,
    });

    const result = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result.transactions_imported).toBe(0);
    expect(result.transactions_skipped).toBe(2);
  });

  it("handles pagination with cursor", async () => {
    let callCount = 0;
    const ext = makeExt({
      fetchTransactions: async (_addr, cursor) => {
        callCount++;
        if (!cursor) {
          return {
            transactions: [{ id: "tx1", timestamp: 1704067200, data: {} }],
            nextCursor: "page2",
          };
        }
        return {
          transactions: [{ id: "tx2", timestamp: 1704067300, data: {} }],
          nextCursor: null,
        };
      },
      processTransaction: (tx) => ({
        source: `test-chain:${tx.id}`,
        date: "2025-01-01",
        description: `Tx ${tx.id}`,
        items: [
          { account: "Assets:Crypto:Wallet:TestChain:Mywallet", currency: "TST", amount: "1" },
          { account: "Assets:Crypto:Wallet:TestChain:External", currency: "TST", amount: "-1" },
        ],
      }),
    });

    const result = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(callCount).toBe(2);
    expect(result.transactions_imported).toBe(2);
  });

  it("updates cursor after sync", async () => {
    // First add the account to the database
    await backend.addBlockchainAccount({
      id: "test-id",
      chain: "test-chain",
      address: "0x1234567890abcdef1234567890abcdef12345678",
      label: "MyWallet",
      created_at: "2025-01-01",
    });

    const ext = makeExt({
      fetchTransactions: async () => ({
        transactions: [{ id: "tx1", timestamp: 1704067200, data: {} }],
        nextCursor: "cursor-after-page1",
      }),
      processTransaction: (tx) => ({
        source: `test-chain:${tx.id}`,
        date: "2025-01-01",
        description: "Test",
        items: [
          { account: "Assets:Crypto:Wallet:TestChain:W", currency: "TST", amount: "1" },
          { account: "Assets:Crypto:Wallet:TestChain:E", currency: "TST", amount: "-1" },
        ],
      }),
    });

    await syncPluginChain(backend, ext, makeAccount(), {});

    // Verify cursor was updated
    const accounts = await backend.listBlockchainAccounts("test-chain");
    expect(accounts[0].cursor).toBe("cursor-after-page1");
    expect(accounts[0].last_sync).not.toBeNull();
  });

  it("catches and records processTransaction errors as warnings", async () => {
    const ext = makeExt({
      fetchTransactions: async () => ({
        transactions: [{ id: "tx1", timestamp: 1704067200, data: {} }],
        nextCursor: null,
      }),
      processTransaction: () => { throw new Error("Parse failed"); },
    });

    const result = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result.transactions_skipped).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Parse failed");
  });

  it("catches and records fetch errors as warnings", async () => {
    const ext = makeExt({
      fetchTransactions: async () => { throw new Error("Network error"); },
    });

    const result = await syncPluginChain(backend, ext, makeAccount(), {});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Network error");
  });

  it("passes config to fetchTransactions", async () => {
    let receivedConfig: Record<string, string> = {};
    const ext = makeExt({
      fetchTransactions: async (_addr, _cursor, config) => {
        receivedConfig = config;
        return { transactions: [], nextCursor: null };
      },
    });

    await syncPluginChain(backend, ext, makeAccount(), { apiKey: "my-secret" });
    expect(receivedConfig.apiKey).toBe("my-secret");
  });
});
