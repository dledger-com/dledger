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
  });

  it("creates an HTTP client with custom URL", () => {
    const client = createDpriceClient({ dpriceUrl: "http://example.com:9090" });
    expect(client).toBeDefined();
  });

  it("DpriceClient interface has all required methods", () => {
    // Type-level test: ensure the interface matches
    const _typeCheck: DpriceClient = {
      health: async () => ({ assets: 0, prices: 0 }),
      getRate: async () => null,
      getRates: async () => [],
      getPriceRange: async () => [],
      sync: async () => "ok",
    };
    expect(_typeCheck).toBeDefined();
  });
});
