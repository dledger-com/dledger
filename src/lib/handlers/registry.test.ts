import { describe, it, expect, beforeEach } from "vitest";
import { HandlerRegistry } from "./registry.js";
import { GenericEtherscanHandler } from "./generic-etherscan.js";
import { pendleHandler } from "./pendle.js";
import { createTestBackend } from "../../test/helpers.js";
import { createMockHandlerContext } from "../../test/mock-handler-context.js";
import type { HandlerContext, TxHashGroup } from "./types.js";
import type { SqlJsBackend } from "../sql-js-backend.js";

function makeEmptyGroup(): TxHashGroup {
  return {
    hash: "0x1234",
    timestamp: "1704067200",
    normal: null,
    internals: [],
    erc20s: [],
    erc721s: [],
    erc1155s: [],
  };
}

describe("HandlerRegistry", () => {
  let backend: SqlJsBackend;
  let ctx: HandlerContext;
  let registry: HandlerRegistry;

  beforeEach(async () => {
    backend = await createTestBackend();
    ctx = createMockHandlerContext(backend);
    registry = new HandlerRegistry();
    registry.register(GenericEtherscanHandler);
    registry.register(pendleHandler);
  });

  it("findBest returns generic when no handler matches", () => {
    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).toBe("generic-etherscan");
  });

  it("findBest returns highest-confidence handler", () => {
    const highConfidenceHandler = {
      id: "test-high",
      name: "High Confidence",
      description: "test",
      supportedChainIds: [],
      match: () => 99,
      process: async () => ({ type: "skip" as const, reason: "test" }),
    };
    registry.register(highConfidenceHandler);

    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).toBe("test-high");
  });

  it("findBest respects chain filter", () => {
    const chainSpecificHandler = {
      id: "chain-specific",
      name: "Chain Specific",
      description: "test",
      supportedChainIds: [137], // Polygon only
      match: () => 99,
      process: async () => ({ type: "skip" as const, reason: "test" }),
    };
    registry.register(chainSpecificHandler);

    // chainId=1 (Ethereum) should not match chain-specific handler
    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).not.toBe("chain-specific");
  });

  it("all handlers participate in scoring (no enabled check)", () => {
    // All registered handlers should be candidates regardless of settings
    const highConfidenceHandler = {
      id: "always-active",
      name: "Always Active",
      description: "test",
      supportedChainIds: [],
      match: () => 99,
      process: async () => ({ type: "skip" as const, reason: "test" }),
    };
    registry.register(highConfidenceHandler);
    // No need to add to settings.handlers — all handlers participate

    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).toBe("always-active");
  });

  it("processGroup falls back to generic on handler error", async () => {
    const failingHandler = {
      id: "failing",
      name: "Failing Handler",
      description: "test",
      supportedChainIds: [],
      match: () => 99,
      process: async () => { throw new Error("intentional failure"); },
    };
    registry.register(failingHandler);

    const group = makeEmptyGroup();
    const result = await registry.processGroup(group, ctx);
    expect(result.handlerId).toBe("generic-etherscan");
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain("failing");
  });

  it("processGroup returns warnings from fallback", async () => {
    const group = makeEmptyGroup();
    const result = await registry.processGroup(group, ctx);
    // With empty group, generic handler should process without error
    expect(result.handlerId).toBe("generic-etherscan");
  });
});
