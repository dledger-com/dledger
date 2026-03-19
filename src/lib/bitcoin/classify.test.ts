import { describe, it, expect } from "vitest";
import type { BtcApiTx } from "./types.js";
import { classifyBtcTx } from "./classify.js";

const ADDR_A = "bc1qaddr_a_owned_by_wallet_main_aaaaaaaaaaaaa";
const ADDR_B = "bc1qaddr_b_owned_by_wallet_main_bbbbbbbbbbbbb";
const ADDR_C = "bc1qaddr_c_owned_by_wallet_cold_ccccccccccccc";
const ADDR_EXT1 = "bc1qexternal_recipient_1_xxxxxxxxxxxxxxxx";
const ADDR_EXT2 = "bc1qexternal_sender_2_yyyyyyyyyyyyyyyy";

function makeOwned(): { ownedAddresses: Set<string>; addressToWallet: Map<string, string> } {
  const ownedAddresses = new Set([ADDR_A, ADDR_B, ADDR_C]);
  const addressToWallet = new Map([
    [ADDR_A, "Main"],
    [ADDR_B, "Main"],
    [ADDR_C, "Cold"],
  ]);
  return { ownedAddresses, addressToWallet };
}

function makeTx(overrides: Partial<BtcApiTx> = {}): BtcApiTx {
  return {
    txid: "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233",
    status: { confirmed: true, block_time: 1704067200, block_height: 800000 },
    vin: [],
    vout: [],
    fee: 1000,
    ...overrides,
  };
}

describe("classifyBtcTx", () => {
  it("classifies a pure receive (no owned inputs)", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_EXT2, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 90000, n: 0 },
        { scriptpubkey_address: ADDR_EXT2, value: 9000, n: 1 }, // change back to sender
      ],
      fee: 1000,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("receive");
    expect(result.fee).toBe(0); // receiver doesn't pay fee
    expect(result.externalReceived).toBe(90000);
    expect(result.externalRecipients).toHaveLength(0);
    expect(result.walletChanges.get("Main")).toBe(90000);
  });

  it("classifies a send with change (owned inputs, some external outputs)", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_EXT1, value: 50000, n: 0 }, // recipient
        { scriptpubkey_address: ADDR_B, value: 48000, n: 1 },    // change
      ],
      fee: 2000,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("send");
    expect(result.fee).toBe(2000);
    expect(result.externalSent).toBe(50000);
    expect(result.externalRecipients).toEqual([ADDR_EXT1]);
    // Net Main wallet change: -100000 (input) + 48000 (change) = -52000
    expect(result.walletChanges.get("Main")).toBe(-52000);
  });

  it("classifies a consolidation (all owned, single wallet)", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 50000 } },
        { txid: "prev2", vout: 1, prevout: { scriptpubkey_address: ADDR_B, value: 30000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 79000, n: 0 }, // all back to Main
      ],
      fee: 1000,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("consolidation");
    expect(result.fee).toBe(1000);
    expect(result.externalSent).toBe(0);
    expect(result.externalRecipients).toHaveLength(0);
    // Net: -50000 - 30000 + 79000 = -1000 (the fee)
    expect(result.walletChanges.get("Main")).toBe(-1000);
  });

  it("classifies a cross-wallet self-transfer (all owned, multiple wallets)", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_C, value: 90000, n: 0 },  // to Cold wallet
        { scriptpubkey_address: ADDR_B, value: 8000, n: 1 },   // change to Main
      ],
      fee: 2000,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("self");
    expect(result.fee).toBe(2000);
    expect(result.externalSent).toBe(0);
    // Main: -100000 + 8000 = -92000
    expect(result.walletChanges.get("Main")).toBe(-92000);
    // Cold: +90000
    expect(result.walletChanges.get("Cold")).toBe(90000);
  });

  it("handles multi-input send", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 40000 } },
        { txid: "prev2", vout: 1, prevout: { scriptpubkey_address: ADDR_B, value: 60000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_EXT1, value: 80000, n: 0 },
        { scriptpubkey_address: ADDR_A, value: 18500, n: 1 },
      ],
      fee: 1500,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("send");
    expect(result.fee).toBe(1500);
    expect(result.externalSent).toBe(80000);
    // Main: -40000 - 60000 + 18500 = -81500
    expect(result.walletChanges.get("Main")).toBe(-81500);
  });

  it("handles null prevout in vin (coinbase)", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "0000000000000000000000000000000000000000000000000000000000000000", vout: 0, prevout: null },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 625000000, n: 0 },
      ],
      fee: 0,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    // No owned inputs (null prevout) → receive
    expect(result.type).toBe("receive");
    expect(result.fee).toBe(0);
    expect(result.externalReceived).toBe(625000000);
    expect(result.walletChanges.get("Main")).toBe(625000000);
  });

  it("handles receive to multiple wallets", () => {
    const { ownedAddresses, addressToWallet } = makeOwned();
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_EXT2, value: 200000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 100000, n: 0 },
        { scriptpubkey_address: ADDR_C, value: 90000, n: 1 },
        { scriptpubkey_address: ADDR_EXT2, value: 9000, n: 2 },
      ],
      fee: 1000,
    });

    const result = classifyBtcTx(tx, ownedAddresses, addressToWallet);

    expect(result.type).toBe("receive");
    expect(result.externalReceived).toBe(190000); // 100000 + 90000
    expect(result.walletChanges.get("Main")).toBe(100000);
    expect(result.walletChanges.get("Cold")).toBe(90000);
  });
});
