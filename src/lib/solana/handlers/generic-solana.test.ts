import { describe, it, expect } from "vitest";
import { genericSolanaHandler, lamportsToSol, shortAddr } from "./generic-solana.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandlerContext } from "./types.js";
import Decimal from "decimal.js-light";

const WALLET = "So11111111111111111111111111111111111111112";
const EXTERNAL = "ExtAddr1111111111111111111111111111111111";

function makeCtx(overrides?: Partial<SolanaHandlerContext>): SolanaHandlerContext {
  return {
    address: WALLET,
    label: "TestWallet",
    backend: {} as any,
    settings: {} as any,
    ensureAccount: async (name: string) => name,
    ensureCurrency: async () => {},
    ...overrides,
  };
}

function makeTx(overrides?: Partial<SolTxGroup>): SolTxGroup {
  return {
    signature: "test-sig-1",
    timestamp: 1700000000,
    slot: 100000,
    fee: 5000,
    feePayer: WALLET,
    status: "success",
    nativeTransfers: [],
    tokenTransfers: [],
    instructions: [],
    ...overrides,
  };
}

describe("lamportsToSol", () => {
  it("converts lamports to SOL", () => {
    expect(lamportsToSol(1000000000).toString()).toBe("1");
    expect(lamportsToSol(5000).toString()).toBe("0.000005");
    expect(lamportsToSol(0).toString()).toBe("0");
  });
});

describe("shortAddr", () => {
  it("truncates long addresses", () => {
    expect(shortAddr("So11111111111111111111111111111111111111112")).toBe("So111111…1112");
  });

  it("keeps short addresses as-is", () => {
    expect(shortAddr("short")).toBe("short");
  });
});

describe("genericSolanaHandler", () => {
  it("has correct metadata", () => {
    expect(genericSolanaHandler.id).toBe("generic-solana");
    expect(genericSolanaHandler.match(makeTx(), makeCtx())).toBe(1);
  });

  it("skips failed transactions", () => {
    expect(genericSolanaHandler.match(makeTx({ status: "failed" }), makeCtx())).toBe(0);
  });

  it("handles SOL receive", async () => {
    const tx = makeTx({
      nativeTransfers: [
        { from: EXTERNAL, to: WALLET, amount: 1000000000 }, // 1 SOL
      ],
    });
    const result = await genericSolanaHandler.process(tx, makeCtx());
    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;
    expect(result.entries).toHaveLength(1);
    const items = result.entries[0].items;
    // Should have wallet debit, external credit, fee items
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it("handles SOL send", async () => {
    const tx = makeTx({
      nativeTransfers: [
        { from: WALLET, to: EXTERNAL, amount: 500000000 }, // 0.5 SOL
      ],
    });
    const result = await genericSolanaHandler.process(tx, makeCtx());
    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;
    expect(result.entries).toHaveLength(1);
  });

  it("handles fee-only transaction (no transfers)", async () => {
    const tx = makeTx({
      nativeTransfers: [],
      tokenTransfers: [],
      instructions: [{ programId: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", accounts: [] }],
    });
    const result = await genericSolanaHandler.process(tx, makeCtx());
    // ATA creation with fee should still produce entries
    expect(result.type).toBe("entries");
  });

  it("handles SPL token receive", async () => {
    const tx = makeTx({
      tokenTransfers: [
        {
          from: EXTERNAL,
          to: WALLET,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "1000000",
          decimals: 6,
          tokenSymbol: "USDC",
        },
      ],
    });
    const result = await genericSolanaHandler.process(tx, makeCtx());
    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;
    expect(result.entries[0].items.some(i => i.currency === "USDC")).toBe(true);
  });

  it("records metadata", async () => {
    const tx = makeTx({
      nativeTransfers: [{ from: EXTERNAL, to: WALLET, amount: 100000000 }],
      type: "TRANSFER",
      source: "SYSTEM_PROGRAM",
    });
    const result = await genericSolanaHandler.process(tx, makeCtx());
    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;
    const meta = result.entries[0].metadata;
    expect(meta["sol:signature"]).toBe("test-sig-1");
    expect(meta["sol:slot"]).toBe("100000");
    expect(meta["sol:fee_lamports"]).toBe("5000");
    expect(meta["sol:type"]).toBe("TRANSFER");
    expect(meta["sol:source"]).toBe("SYSTEM_PROGRAM");
  });
});
