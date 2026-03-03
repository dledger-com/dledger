import { describe, it, expect } from "vitest";
import { createDpriceClient, type DpriceClient } from "./dprice-client.js";

describe("dprice-client", () => {
  it("creates an HTTP client when not in Tauri", () => {
    const client = createDpriceClient();
    expect(client).toBeDefined();
    expect(client.health).toBeInstanceOf(Function);
    expect(client.getRate).toBeInstanceOf(Function);
    expect(client.getRates).toBeInstanceOf(Function);
    expect(client.getPriceRange).toBeInstanceOf(Function);
    expect(client.sync).toBeInstanceOf(Function);
    expect(client.syncLatest).toBeInstanceOf(Function);
    expect(client.latestDate).toBeInstanceOf(Function);
    expect(client.ensurePrices).toBeInstanceOf(Function);
    expect(client.exportDb).toBeInstanceOf(Function);
    expect(client.importDb).toBeInstanceOf(Function);
  });

  it("creates an HTTP client with custom URL via http mode", () => {
    const client = createDpriceClient({ dpriceMode: "http", dpriceUrl: "http://example.com:9090" });
    expect(client).toBeDefined();
  });

  it("creates an HTTP client for integrated mode in non-Tauri env", () => {
    // In test env (no Tauri), integrated/local falls back to HTTP
    const client = createDpriceClient({ dpriceMode: "integrated" });
    expect(client).toBeDefined();
  });

  it("creates an HTTP client for local mode in non-Tauri env", () => {
    const client = createDpriceClient({ dpriceMode: "local" });
    expect(client).toBeDefined();
  });

  it("creates an HTTP client when mode is off or undefined", () => {
    const clientOff = createDpriceClient({ dpriceMode: "off" });
    expect(clientOff).toBeDefined();

    const clientUndef = createDpriceClient();
    expect(clientUndef).toBeDefined();
  });

  it("DpriceClient interface has all required methods", () => {
    // Type-level test: ensure the interface matches
    const _typeCheck: DpriceClient = {
      health: async () => ({ assets: 0, prices: 0 }),
      getRate: async () => null,
      getRates: async () => [],
      getPriceRange: async () => [],
      getPriceRangeBatch: async () => ({ from: "", to: "", currencies: [] }),
      sync: async () => "ok",
      syncLatest: async () => "ok",
      latestDate: async () => null,
      ensurePrices: async () => [],
      exportDb: async () => new Uint8Array(),
      importDb: async () => "ok",
    };
    expect(_typeCheck).toBeDefined();
  });
});
