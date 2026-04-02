import { describe, it, expect } from "vitest";
import Decimal from "decimal.js-light";
import type { BtcApiTx } from "./types.js";
import type { BtcClassification } from "./classify.js";
import { buildBtcItems, satsToBtc, shortAddr, accountPathAddr } from "./entries.js";
import { normalizeAccountSegment } from "../accounts/paths.js";

const ADDR_A = "bc1qaddr_a_owned_by_wallet_main_aaaaaaaaaaaaa";
const ADDR_B = "bc1qaddr_b_owned_by_wallet_main_bbbbbbbbbbbbb";
const ADDR_C = "bc1qaddr_c_owned_by_wallet_cold_ccccccccccccc";
const ADDR_EXT1 = "bc1qexternal_recipient_1_xxxxxxxxxxxxxxxx";
const ADDR_EXT2 = "bc1qexternal_sender_2_yyyyyyyyyyyyyyyy";

const addressToWallet = new Map([
  [ADDR_A, "Main"],
  [ADDR_B, "Main"],
  [ADDR_C, "Cold"],
]);

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

/** Verify that all items sum to zero (double-entry invariant). */
function assertZeroSum(items: { amount: Decimal }[]) {
  const total = items.reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
  expect(total.isZero()).toBe(true);
}

describe("satsToBtc", () => {
  it("converts satoshis to BTC", () => {
    expect(satsToBtc(100000000).toString()).toBe("1");
    expect(satsToBtc(50000000).toString()).toBe("0.5");
    expect(satsToBtc(1).toFixed(8)).toBe("0.00000001");
    expect(satsToBtc(0).toString()).toBe("0");
  });
});

describe("shortAddr", () => {
  it("truncates long addresses", () => {
    expect(shortAddr("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe("bc1qw508…f3t4");
  });

  it("returns short addresses unchanged", () => {
    expect(shortAddr("abcdef1234567890")).toBe("abcdef1234567890");
  });
});

describe("buildBtcItems — receive", () => {
  it("creates balanced items for a simple receive", () => {
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_EXT2, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 90000, n: 0 },
        { scriptpubkey_address: ADDR_EXT2, value: 9000, n: 1 },
      ],
    });

    const classification: BtcClassification = {
      type: "receive",
      walletChanges: new Map([["Main", 90000]]),
      externalSent: 0,
      externalRecipients: [],
      fee: 0,
      externalReceived: 90000,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);

    expect(items).toHaveLength(2);
    assertZeroSum(items);

    // Wallet gets +0.0009 BTC
    const walletItem = items.find((i) => i.account.includes("Main"));
    expect(walletItem).toBeDefined();
    expect(walletItem!.amount.toString()).toBe("0.0009");
    expect(walletItem!.currency).toBe("BTC");

    // External source is negative
    const extItem = items.find((i) => i.account.includes("External"));
    expect(extItem).toBeDefined();
    expect(extItem!.amount.isNegative()).toBe(true);
  });
});

describe("buildBtcItems — send", () => {
  it("creates balanced items for a send with change", () => {
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_EXT1, value: 50000, n: 0 },
        { scriptpubkey_address: ADDR_B, value: 48000, n: 1 },
      ],
      fee: 2000,
    });

    const classification: BtcClassification = {
      type: "send",
      walletChanges: new Map([["Main", -52000]]), // -100000 + 48000
      externalSent: 50000,
      externalRecipients: [ADDR_EXT1],
      fee: 2000,
      externalReceived: 0,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);

    assertZeroSum(items);

    // Should have: wallet (neg), external (pos), fee (pos)
    const walletItem = items.find((i) => i.account.includes("Main"));
    expect(walletItem).toBeDefined();
    expect(walletItem!.amount.isNegative()).toBe(true);
    expect(walletItem!.amount.toString()).toBe("-0.00052");

    const feeItem = items.find((i) => i.account.includes("Fees"));
    expect(feeItem).toBeDefined();
    expect(feeItem!.amount.toString()).toBe("0.00002");

    const extItem = items.find((i) => i.account.includes("External"));
    expect(extItem).toBeDefined();
    expect(extItem!.amount.toString()).toBe("0.0005");
  });

  it("uses correct account paths", () => {
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 50000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_EXT1, value: 48000, n: 0 },
      ],
      fee: 2000,
    });

    const classification: BtcClassification = {
      type: "send",
      walletChanges: new Map([["Main", -50000]]),
      externalSent: 48000,
      externalRecipients: [ADDR_EXT1],
      fee: 2000,
      externalReceived: 0,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);

    const walletItem = items.find((i) => i.account.includes("Main"));
    expect(walletItem!.account).toBe("Assets:Crypto:Wallet:Bitcoin:Main");

    const feeItem = items.find((i) => i.account.includes("Fees"));
    expect(feeItem!.account).toBe("Expenses:Crypto:Fees:Bitcoin");

    const extItem = items.find((i) => i.account.includes("External"));
    expect(extItem!.account).toBe(`Equity:Crypto:Wallet:Bitcoin:External:${normalizeAccountSegment(accountPathAddr(ADDR_EXT1))}`);
  });
});

describe("buildBtcItems — consolidation", () => {
  it("creates balanced items (only fee)", () => {
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 50000 } },
        { txid: "prev2", vout: 1, prevout: { scriptpubkey_address: ADDR_B, value: 30000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_A, value: 79000, n: 0 },
      ],
      fee: 1000,
    });

    const classification: BtcClassification = {
      type: "consolidation",
      walletChanges: new Map([["Main", -1000]]), // net = -fee
      externalSent: 0,
      externalRecipients: [],
      fee: 1000,
      externalReceived: 0,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);

    expect(items).toHaveLength(2);
    assertZeroSum(items);

    const feeItem = items.find((i) => i.account.includes("Fees"));
    expect(feeItem!.amount.toString()).toBe("0.00001");
  });

  it("produces no items when fee is zero", () => {
    const tx = makeTx({ fee: 0 });
    const classification: BtcClassification = {
      type: "consolidation",
      walletChanges: new Map(),
      externalSent: 0,
      externalRecipients: [],
      fee: 0,
      externalReceived: 0,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);
    expect(items).toHaveLength(0);
  });
});

describe("buildBtcItems — self (cross-wallet)", () => {
  it("creates balanced items for cross-wallet transfer", () => {
    const tx = makeTx({
      vin: [
        { txid: "prev1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000 } },
      ],
      vout: [
        { scriptpubkey_address: ADDR_C, value: 90000, n: 0 },
        { scriptpubkey_address: ADDR_B, value: 8000, n: 1 },
      ],
      fee: 2000,
    });

    const classification: BtcClassification = {
      type: "self",
      walletChanges: new Map([
        ["Main", -92000], // -100000 + 8000
        ["Cold", 90000],
      ]),
      externalSent: 0,
      externalRecipients: [],
      fee: 2000,
      externalReceived: 0,
    };

    const items = buildBtcItems(tx, classification, addressToWallet);

    assertZeroSum(items);

    // Main decreases, Cold increases, fee expense
    const mainItem = items.find((i) => i.account.includes("Main"));
    expect(mainItem!.amount.isNegative()).toBe(true);

    const coldItem = items.find((i) => i.account.includes("Cold"));
    expect(coldItem!.amount.isPositive()).toBe(true);
    expect(coldItem!.amount.toString()).toBe("0.0009");

    const feeItem = items.find((i) => i.account.includes("Fees"));
    expect(feeItem!.amount.toString()).toBe("0.00002");
  });
});

describe("buildBtcItems — zero-sum invariant across all types", () => {
  const cases: Array<{ name: string; classification: BtcClassification; tx: BtcApiTx }> = [
    {
      name: "receive 1 BTC",
      tx: makeTx({
        vin: [{ txid: "p", vout: 0, prevout: { scriptpubkey_address: ADDR_EXT2, value: 100000000 } }],
        vout: [{ scriptpubkey_address: ADDR_A, value: 100000000, n: 0 }],
        fee: 0,
      }),
      classification: {
        type: "receive",
        walletChanges: new Map([["Main", 100000000]]),
        externalSent: 0,
        externalRecipients: [],
        fee: 0,
        externalReceived: 100000000,
      },
    },
    {
      name: "send 0.5 BTC with 500 sat fee",
      tx: makeTx({
        vin: [{ txid: "p", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000000 } }],
        vout: [
          { scriptpubkey_address: ADDR_EXT1, value: 50000000, n: 0 },
          { scriptpubkey_address: ADDR_B, value: 49999500, n: 1 },
        ],
        fee: 500,
      }),
      classification: {
        type: "send",
        walletChanges: new Map([["Main", -50000500]]),
        externalSent: 50000000,
        externalRecipients: [ADDR_EXT1],
        fee: 500,
        externalReceived: 0,
      },
    },
    {
      name: "consolidation with 300 sat fee",
      tx: makeTx({
        vin: [
          { txid: "p1", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 50000 } },
          { txid: "p2", vout: 0, prevout: { scriptpubkey_address: ADDR_B, value: 50000 } },
        ],
        vout: [{ scriptpubkey_address: ADDR_A, value: 99700, n: 0 }],
        fee: 300,
      }),
      classification: {
        type: "consolidation",
        walletChanges: new Map([["Main", -300]]),
        externalSent: 0,
        externalRecipients: [],
        fee: 300,
        externalReceived: 0,
      },
    },
    {
      name: "cross-wallet self-transfer",
      tx: makeTx({
        vin: [{ txid: "p", vout: 0, prevout: { scriptpubkey_address: ADDR_A, value: 100000 } }],
        vout: [
          { scriptpubkey_address: ADDR_C, value: 99000, n: 0 },
        ],
        fee: 1000,
      }),
      classification: {
        type: "self",
        walletChanges: new Map([["Main", -100000], ["Cold", 99000]]),
        externalSent: 0,
        externalRecipients: [],
        fee: 1000,
        externalReceived: 0,
      },
    },
  ];

  for (const { name, classification, tx } of cases) {
    it(`sums to zero for: ${name}`, () => {
      const items = buildBtcItems(tx, classification, addressToWallet);
      assertZeroSum(items);
    });
  }
});
