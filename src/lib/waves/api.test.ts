import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetRateLimiter, WavesClient } from "./api.js";

vi.mock("../cex/fetch.js", () => ({
  cexFetch: vi.fn(),
  abortableDelay: vi.fn().mockResolvedValue(undefined),
}));

import { cexFetch } from "../cex/fetch.js";

const mockedFetch = vi.mocked(cexFetch);

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimiter();
});

const ADDR = "3PTestAddress00000000000000000000000";

describe("WavesClient.fetchTransactionsPage", () => {
  it("unwraps the outer array and returns the inner page", async () => {
    const tx = {
      id: "tx1",
      type: 4,
      sender: ADDR,
      senderPublicKey: "pk",
      recipient: "3POther",
      amount: 100000000,
      assetId: null,
      fee: 100000,
      feeAssetId: null,
      timestamp: 1700000000000,
    };
    mockedFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify([[tx]]) });

    const client = new WavesClient();
    const page = await client.fetchTransactionsPage(ADDR);

    expect(page).toHaveLength(1);
    expect(page[0].id).toBe("tx1");
    expect(mockedFetch).toHaveBeenCalledWith(
      `https://nodes.wavesnodes.com/transactions/address/${ADDR}/limit/100`,
      "https://nodes.wavesnodes.com",
      "/api/waves",
      expect.objectContaining({ method: "GET" }),
      undefined,
    );
  });

  it("passes the `after` cursor in the query string", async () => {
    mockedFetch.mockResolvedValueOnce({ status: 200, body: "[[]]" });
    const client = new WavesClient();
    await client.fetchTransactionsPage(ADDR, "lastIdXYZ");

    expect(mockedFetch).toHaveBeenCalledWith(
      `https://nodes.wavesnodes.com/transactions/address/${ADDR}/limit/100?after=lastIdXYZ`,
      expect.anything(), expect.anything(), expect.anything(), undefined,
    );
  });

  it("retries on 429", async () => {
    mockedFetch
      .mockResolvedValueOnce({ status: 429, body: "rate limited" })
      .mockResolvedValueOnce({ status: 200, body: "[[]]" });
    const client = new WavesClient();
    const page = await client.fetchTransactionsPage(ADDR);
    expect(page).toEqual([]);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("throws on other non-2xx statuses", async () => {
    mockedFetch.mockResolvedValueOnce({ status: 400, body: "bad request" });
    const client = new WavesClient();
    await expect(client.fetchTransactionsPage(ADDR)).rejects.toThrow("Waves API error 400");
  });
});

describe("WavesClient.fetchNewTransactions", () => {
  it("stops when hitting the cursor tx id", async () => {
    const makeTx = (id: string) => ({
      id, type: 4, sender: ADDR, senderPublicKey: "pk", recipient: "3POther",
      amount: 100000000, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1700000000000,
    });
    const page = [makeTx("new2"), makeTx("new1"), makeTx("cursor"), makeTx("old1")];
    mockedFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify([page]) });

    const client = new WavesClient();
    const txs = await client.fetchNewTransactions(ADDR, "cursor");
    expect(txs.map((t) => t.id)).toEqual(["new2", "new1"]);
  });

  it("paginates across full pages", async () => {
    const big = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`, type: 4, sender: ADDR, senderPublicKey: "pk",
      recipient: "3POther", amount: 100, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1700000000000,
    }));
    const second = [{
      id: "p2-0", type: 4, sender: ADDR, senderPublicKey: "pk",
      recipient: "3POther", amount: 100, assetId: null, fee: 100000, feeAssetId: null, timestamp: 1700000000000,
    }];
    mockedFetch
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify([big]) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify([second]) });

    const client = new WavesClient();
    const txs = await client.fetchNewTransactions(ADDR, null);
    expect(txs).toHaveLength(101);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

describe("WavesClient.getAssetDetails", () => {
  it("caches results", async () => {
    const details = {
      assetId: "ASSET1", name: "Token", description: "", decimals: 6,
      issuer: "3PIssuer", quantity: 1000000, reissuable: false,
    };
    mockedFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(details) });

    const client = new WavesClient();
    const a = await client.getAssetDetails("ASSET1");
    const b = await client.getAssetDetails("ASSET1");
    expect(a).toEqual(details);
    expect(b).toEqual(details);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
