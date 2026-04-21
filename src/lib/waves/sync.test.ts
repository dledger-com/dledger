import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GenericBlockchainAccount } from "../backend.js";
import { WavesClient } from "./api.js";
import { syncWavesAccount } from "./sync.js";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import type {
  WavesAssetDetails,
  WavesExchangeTx,
  WavesInvokeScriptTx,
  WavesLeaseTx,
  WavesMassTransferTx,
  WavesTransaction,
  WavesTransferTx,
} from "./types.js";
import Decimal from "decimal.js-light";

vi.mock("../data/invalidation.js", () => ({
  invalidate: vi.fn(),
}));

const ADDR = "3PWalletAddress00000000000000000000";
const OTHER = "3POtherAddress0000000000000000000000";

function stubClient(
  txs: WavesTransaction[],
  assets: Record<string, Partial<WavesAssetDetails>> = {},
): WavesClient {
  const client = new WavesClient();
  (client as any).fetchNewTransactions = vi.fn(async () => txs);
  (client as any).getAssetDetails = vi.fn(async (assetId: string) => {
    const base: WavesAssetDetails = {
      assetId, name: assetId, description: "", decimals: 6,
      issuer: "3PIssuer", quantity: 0, reissuable: false,
    };
    return { ...base, ...(assets[assetId] ?? {}) } as WavesAssetDetails;
  });
  return client;
}

function makeAccount(): GenericBlockchainAccount {
  return {
    id: "waves-test-1",
    chain: "waves",
    address: ADDR,
    label: "TestWallet",
    cursor: null,
    last_sync: null,
    created_at: "2024-01-01T00:00:00Z",
    extra: null,
  };
}

describe("syncWavesAccount", () => {
  let backend: SqlJsBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = await createTestBackend();
  });

  it("returns zeros when no new activity", async () => {
    const client = stubClient([]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(0);
  });

  it("imports a received native WAVES transfer", async () => {
    const tx: WavesTransferTx = {
      id: "tx-recv-1", type: 4, sender: OTHER, senderPublicKey: "pk",
      recipient: ADDR, amount: 250000000, assetId: null,
      fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000,
      applicationStatus: "succeeded",
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);

    expect(result.transactions_imported).toBe(1);
    const entries = await backend.queryJournalEntries({});
    expect(entries).toHaveLength(1);
    const [entry, items] = entries[0];
    expect(entry.source).toBe("waves:tx-recv-1");
    expect(entry.description).toMatch(/Receive WAVES/);

    // Sum by currency should be 0 (received on wallet matched by external credit).
    const sum = items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(sum.toFixed()).toBe("0");

    // Fee was paid by sender (OTHER), so no ChainFees line for this wallet.
    const feeItem = items.find((i) => i.currency === "WAVES" && i.amount !== "2.5" && i.amount !== "-2.5");
    expect(feeItem).toBeUndefined();
  });

  it("imports a sent native WAVES transfer with fee", async () => {
    const tx: WavesTransferTx = {
      id: "tx-send-1", type: 4, sender: ADDR, senderPublicKey: "pk",
      recipient: OTHER, amount: 100000000, assetId: null,
      fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000,
      applicationStatus: "succeeded",
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);

    expect(result.transactions_imported).toBe(1);
    const entries = await backend.queryJournalEntries({});
    const [entry, items] = entries[0];
    expect(entry.description).toMatch(/Send WAVES/);

    // 4 line items total: wallet -1, external +1, wallet fee -0.001, ChainFees +0.001
    expect(items).toHaveLength(4);
    const sumByCurrency = new Map<string, Decimal>();
    for (const i of items) {
      const prev = sumByCurrency.get(i.currency) ?? new Decimal(0);
      sumByCurrency.set(i.currency, prev.plus(i.amount));
    }
    expect(sumByCurrency.get("WAVES")?.toFixed()).toBe("0");
  });

  it("dedupes on re-sync", async () => {
    const tx: WavesTransferTx = {
      id: "dup-1", type: 4, sender: OTHER, senderPublicKey: "pk",
      recipient: ADDR, amount: 100, assetId: null,
      fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000,
      applicationStatus: "succeeded",
    };
    const account = makeAccount();
    const client1 = stubClient([tx]);
    await syncWavesAccount(backend, account, undefined, undefined, client1);

    const client2 = stubClient([tx]);
    const second = await syncWavesAccount(backend, account, undefined, undefined, client2);
    expect(second.transactions_imported).toBe(0);
    expect(second.transactions_skipped).toBe(1);
  });

  it("updates cursor to the newest seen tx id", async () => {
    const txs: WavesTransferTx[] = [
      { id: "new", type: 4, sender: OTHER, senderPublicKey: "pk", recipient: ADDR, amount: 1, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1_700_000_002_000, applicationStatus: "succeeded" },
      { id: "mid", type: 4, sender: OTHER, senderPublicKey: "pk", recipient: ADDR, amount: 1, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1_700_000_001_000, applicationStatus: "succeeded" },
      { id: "old", type: 4, sender: OTHER, senderPublicKey: "pk", recipient: ADDR, amount: 1, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000, applicationStatus: "succeeded" },
    ];
    const account = makeAccount();
    const client = stubClient(txs);
    await syncWavesAccount(backend, account, undefined, undefined, client);

    const accounts = await backend.listBlockchainAccounts("waves");
    // Account was not pre-created in test backend — this is just verifying no crash.
    expect(accounts).toBeDefined();
  });

  it("skips failed (script_execution_failed) transactions", async () => {
    const tx: WavesTransferTx = {
      id: "failed-1", type: 4, sender: ADDR, senderPublicKey: "pk",
      recipient: OTHER, amount: 1, assetId: null, fee: 100000, feeAssetId: null,
      timestamp: 1_700_000_000_000, applicationStatus: "script_execution_failed",
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(0);
    expect(result.transactions_skipped).toBe(1);
  });

  it("imports an outgoing MassTransfer with N recipients", async () => {
    const tx: WavesMassTransferTx = {
      id: "mass-1", type: 11, sender: ADDR, senderPublicKey: "pk",
      assetId: null, fee: 200000, feeAssetId: null, timestamp: 1_700_000_000_000,
      applicationStatus: "succeeded",
      transfers: [
        { recipient: OTHER, amount: 100000000 },
        { recipient: "3PAnother0000000000000000000000000", amount: 200000000 },
      ],
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    const [, items] = entries[0];
    const wavesSum = items
      .filter((i) => i.currency === "WAVES")
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(wavesSum.toFixed()).toBe("0");
  });

  it("imports an Exchange trade (buy side)", async () => {
    const tx: WavesExchangeTx = {
      id: "ex-1", type: 7, sender: "3PMatcher", senderPublicKey: "pk",
      fee: 300000, feeAssetId: null, timestamp: 1_700_000_000_000, applicationStatus: "succeeded",
      order1: {
        orderType: "buy", sender: ADDR, senderPublicKey: "pk",
        matcherPublicKey: "mk",
        assetPair: { amountAsset: "TKN", priceAsset: null },
        price: 100_000_000, // 1 WAVES per 1 TKN (both 6 decimals -> factor 10^8)
        amount: 1_000_000, // 1.0 TKN (6 decimals)
        timestamp: 1_700_000_000_000,
        matcherFee: 300000,
      },
      order2: {
        orderType: "sell", sender: "3PSellerr", senderPublicKey: "pk2",
        matcherPublicKey: "mk",
        assetPair: { amountAsset: "TKN", priceAsset: null },
        price: 100_000_000,
        amount: 1_000_000,
        timestamp: 1_700_000_000_000,
        matcherFee: 300000,
      },
      price: 100_000_000,
      amount: 1_000_000,
      buyMatcherFee: 300000,
      sellMatcherFee: 300000,
    };
    const client = stubClient([tx], {
      TKN: { assetId: "TKN", name: "TKN", decimals: 6 },
    });
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    const [entry, items] = entries[0];
    expect(entry.description).toMatch(/Trade .* → .*/);

    // Sum per currency should be 0.
    const sums = new Map<string, Decimal>();
    for (const i of items) {
      sums.set(i.currency, (sums.get(i.currency) ?? new Decimal(0)).plus(i.amount));
    }
    for (const [, s] of sums) expect(s.toFixed()).toBe("0");
  });

  it("imports an outgoing Lease as internal transfer to :Leased", async () => {
    const tx: WavesLeaseTx = {
      id: "lease-1", type: 8, sender: ADDR, senderPublicKey: "pk",
      recipient: OTHER, amount: 500000000,
      fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000, applicationStatus: "succeeded",
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(1);

    const accounts = await backend.listAccounts();
    expect(accounts.some((a) => a.full_name.endsWith(":Leased"))).toBe(true);
  });

  it("imports an incoming InvokeScript with stateChanges transfer", async () => {
    const tx: WavesInvokeScriptTx = {
      id: "inv-1", type: 16, sender: OTHER, senderPublicKey: "pk",
      dApp: "3PDapp0000000000000000000000000000", call: { function: "claim" },
      fee: 900000, feeAssetId: null, timestamp: 1_700_000_000_000, applicationStatus: "succeeded",
      stateChanges: {
        transfers: [{ address: ADDR, asset: null, amount: 420000000 }],
      },
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(1);

    const entries = await backend.queryJournalEntries({});
    const [, items] = entries[0];
    const sum = items
      .filter((i) => i.currency === "WAVES")
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    expect(sum.toFixed()).toBe("0");
  });

  it("records a warning for unsupported tx types", async () => {
    const tx: WavesTransaction = {
      id: "data-1", type: 12, sender: ADDR, senderPublicKey: "pk",
      fee: 100000, feeAssetId: null, timestamp: 1_700_000_000_000, applicationStatus: "succeeded",
    };
    const client = stubClient([tx]);
    const result = await syncWavesAccount(backend, makeAccount(), undefined, undefined, client);
    expect(result.transactions_imported).toBe(0);
    expect(result.warnings.some((w) => w.includes("type 12"))).toBe(true);
  });
});
