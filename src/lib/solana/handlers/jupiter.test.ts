import { describe, it, expect } from "vitest";
import { jupiterHandler } from "./jupiter.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandlerContext } from "./types.js";

const WALLET = "WalletAddr111111111111111111111111111111111";
const EXTERNAL_AMM = "AmmPool1111111111111111111111111111111111";

function makeCtx(): SolanaHandlerContext {
  return {
    address: WALLET,
    label: "TestWallet",
    backend: {} as any,
    settings: {} as any,
    ensureAccount: async (name: string) => name,
    ensureCurrency: async () => {},
  };
}

function makeJupiterSwapTx(): SolTxGroup {
  return {
    signature: "jup-swap-sig-1",
    timestamp: 1700000000,
    slot: 200000,
    fee: 5000,
    feePayer: WALLET,
    status: "success",
    type: "SWAP",
    source: "JUPITER",
    nativeTransfers: [],
    tokenTransfers: [
      // Sell USDC
      {
        from: WALLET,
        to: EXTERNAL_AMM,
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "100000000", // 100 USDC
        decimals: 6,
        tokenSymbol: "USDC",
      },
      // Receive SOL-wrapped token
      {
        from: EXTERNAL_AMM,
        to: WALLET,
        mint: "So11111111111111111111111111111111111111112",
        amount: "5000000000", // 5 SOL (wrapped)
        decimals: 9,
        tokenSymbol: "SOL",
      },
    ],
    instructions: [
      { programId: "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd", accounts: [WALLET] },
    ],
  };
}

describe("jupiterHandler", () => {
  it("matches Jupiter transactions by source", () => {
    const tx = makeJupiterSwapTx();
    expect(jupiterHandler.match(tx, makeCtx())).toBe(55);
  });

  it("matches Jupiter transactions by programId", () => {
    const tx = makeJupiterSwapTx();
    tx.source = undefined;
    expect(jupiterHandler.match(tx, makeCtx())).toBe(55);
  });

  it("does not match non-Jupiter transactions", () => {
    const tx = makeJupiterSwapTx();
    tx.source = undefined;
    tx.instructions = [{ programId: "other", accounts: [] }];
    expect(jupiterHandler.match(tx, makeCtx())).toBe(0);
  });

  it("skips failed transactions", () => {
    const tx = makeJupiterSwapTx();
    tx.status = "failed";
    expect(jupiterHandler.match(tx, makeCtx())).toBe(0);
  });

  it("processes a USDC → SOL swap", async () => {
    const tx = makeJupiterSwapTx();
    const result = await jupiterHandler.process(tx, makeCtx());

    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];

    // Should have items for USDC outflow, SOL inflow, and fee
    expect(entry.items.length).toBeGreaterThanOrEqual(4);

    // Description should mention Jupiter swap
    expect(entry.entry.description).toContain("Jupiter swap");
    expect(entry.entry.description).toContain("USDC");

    // Metadata should have handler info
    expect(entry.metadata["sol:handler"]).toBe("jupiter");
    expect(entry.metadata["sol:signature"]).toBe("jup-swap-sig-1");
  });

  it("processes a SOL → token swap with native transfers", async () => {
    const tx: SolTxGroup = {
      signature: "jup-swap-sig-2",
      timestamp: 1700000001,
      slot: 200001,
      fee: 5000,
      feePayer: WALLET,
      status: "success",
      type: "SWAP",
      source: "JUPITER",
      nativeTransfers: [
        { from: WALLET, to: EXTERNAL_AMM, amount: 2000000000 }, // 2 SOL
      ],
      tokenTransfers: [
        {
          from: EXTERNAL_AMM,
          to: WALLET,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "40000000",
          decimals: 6,
          tokenSymbol: "USDC",
        },
      ],
      instructions: [
        { programId: "JUP6LkbMUjesGokfGBSfPq2KG1ZqPByPXGUMcPBJcnWd", accounts: [WALLET] },
      ],
    };

    const result = await jupiterHandler.process(tx, makeCtx());
    expect(result.type).toBe("entries");
    if (result.type !== "entries") return;
    expect(result.entries[0].entry.description).toContain("Jupiter swap");
  });
});
