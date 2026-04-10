import { describe, it, expect } from "vitest";
import { BlockchainSourceRegistry } from "./blockchain-source-registry.js";
import type { BlockchainSourceExtension } from "./types.js";

function makeExt(overrides: Partial<BlockchainSourceExtension> = {}): BlockchainSourceExtension {
  return {
    chainId: "test-chain",
    chainName: "Test Chain",
    symbol: "TST",
    addressRegex: "^0x[a-f0-9]{40}$",
    addressPlaceholder: "0x...",
    fetchTransactions: async () => ({ transactions: [], nextCursor: null }),
    processTransaction: () => null,
    ...overrides,
  };
}

describe("BlockchainSourceRegistry", () => {
  it("registers and retrieves a blockchain source", () => {
    const registry = new BlockchainSourceRegistry();
    registry.register(makeExt());
    expect(registry.has("test-chain")).toBe(true);
    expect(registry.get("test-chain")?.chainName).toBe("Test Chain");
    expect(registry.getAll()).toHaveLength(1);
  });

  it("compiles addressRegex on registration", () => {
    const registry = new BlockchainSourceRegistry();
    registry.register(makeExt());
    const ext = registry.get("test-chain")!;
    expect(ext.compiledRegex).toBeInstanceOf(RegExp);
    expect(ext.compiledRegex.test("0x1234567890abcdef1234567890abcdef12345678")).toBe(true);
    expect(ext.compiledRegex.test("invalid")).toBe(false);
  });

  it("normalizes chainId to lowercase", () => {
    const registry = new BlockchainSourceRegistry();
    registry.register(makeExt({ chainId: "MyChain" }));
    expect(registry.has("mychain")).toBe(true);
    expect(registry.get("MYCHAIN")).toBeDefined();
  });

  it("rejects duplicate chainId", () => {
    const registry = new BlockchainSourceRegistry();
    registry.register(makeExt());
    expect(() => registry.register(makeExt())).toThrow("already registered");
  });

  it("rejects chainId that collides with built-in chain", () => {
    const registry = new BlockchainSourceRegistry();
    expect(() => registry.register(makeExt({ chainId: "sol" }))).toThrow("conflicts with a built-in chain");
    expect(() => registry.register(makeExt({ chainId: "cosmos" }))).toThrow("conflicts with a built-in chain");
  });

  it("getAll returns all registered sources", () => {
    const registry = new BlockchainSourceRegistry();
    registry.register(makeExt({ chainId: "chain-a", chainName: "Chain A" }));
    registry.register(makeExt({ chainId: "chain-b", chainName: "Chain B" }));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(e => e.chainName)).toContain("Chain A");
    expect(all.map(e => e.chainName)).toContain("Chain B");
  });

  it("get returns undefined for unknown chain", () => {
    const registry = new BlockchainSourceRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });
});
