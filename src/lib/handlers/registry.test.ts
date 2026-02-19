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
    // Create a custom handler with high confidence
    const highConfidenceHandler = {
      id: "test-high",
      name: "High Confidence",
      description: "test",
      supportedChainIds: [],
      match: () => 99,
      process: async () => ({ type: "skip" as const, reason: "test" }),
    };
    registry.register(highConfidenceHandler);
    ctx.settings.handlers["test-high"] = { enabled: true };

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
    ctx.settings.handlers["chain-specific"] = { enabled: true };

    // chainId=1 (Ethereum) should not match chain-specific handler
    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).not.toBe("chain-specific");
  });

  it("findBest respects enabled setting", () => {
    // Disable pendle handler
    ctx.settings.handlers["pendle"] = { enabled: false };

    const highConfidenceDisabled = {
      id: "disabled-handler",
      name: "Disabled",
      description: "test",
      supportedChainIds: [],
      match: () => 99,
      process: async () => ({ type: "skip" as const, reason: "test" }),
    };
    registry.register(highConfidenceDisabled);
    // Don't add to enabled handlers

    const group = makeEmptyGroup();
    const handler = registry.findBest(group, ctx);
    expect(handler.id).toBe("generic-etherscan");
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
    ctx.settings.handlers["failing"] = { enabled: true };

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
