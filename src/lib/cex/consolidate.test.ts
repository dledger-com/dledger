import { describe, it, expect, beforeEach } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend } from "../../test/helpers.js";
import type { SqlJsBackend } from "../sql-js-backend.js";
import type { CexAdapter, CexLedgerRecord, ExchangeAccount } from "./types.js";
import { syncCexAccount } from "./pipeline.js";
import { retroactiveConsolidate } from "./consolidate.js";
import type { Account, JournalEntry, LineItem, EtherscanAccount } from "../types/index.js";
import { getDefaultRegistry } from "../handlers/index.js";

// -- Helpers --

function makeExchangeAccount(overrides: Partial<ExchangeAccount> = {}): ExchangeAccount {
  return {
    id: uuidv7(),
    exchange: "kraken",
    label: "Main Kraken",
    api_key: "test-key",
    api_secret: "test-secret",
    last_sync: null,
    created_at: "2024-01-01",
    ...overrides,
  };
}

function makeMockAdapter(records: CexLedgerRecord[], overrides: Partial<CexAdapter> = {}): CexAdapter {
  return {
    exchangeId: "kraken",
    exchangeName: "Kraken",
    normalizeAsset: (raw: string) => raw,
    fetchLedgerRecords: async () => records,
    ...overrides,
  };
}

function ts(dateStr: string): number {
  return Math.floor(new Date(dateStr + "T12:00:00Z").getTime() / 1000);
}

function getAccountName(accounts: Account[], id: string): string | undefined {
  return accounts.find((a) => a.id === id)?.full_name;
}

describe("Retroactive Consolidation", () => {
  let backend: SqlJsBackend;
  const registry = getDefaultRegistry();

  beforeEach(async () => {
    backend = await createTestBackend();
    await backend.createCurrency({ code: "EUR", name: "Euro", decimal_places: 2, is_base: true });
    await backend.createCurrency({ code: "ETH", name: "Ether", decimal_places: 18, is_base: false });
  });

  /**
   * Helper: Simulate an Etherscan entry for a simple ETH transfer.
   * Creates accounts, journal entry with line items, and stores the txid as source hash.
   */
  async function seedEtherscanEntry(
    hash: string,
    date: string,
    walletLabel: string,
    amount: string,
    direction: "in" | "out",
  ): Promise<{ entry: JournalEntry; items: LineItem[] }> {
    const walletAccount = `Assets:Ethereum:${walletLabel}`;
    const externalAddr = "0x1234567890abcdef1234567890abcdef12345678";
    const externalAccount = `Equity:Ethereum:External:${externalAddr}`;

    // Ensure accounts
    for (const fullName of [walletAccount, externalAccount]) {
      const parts = fullName.split(":");
      let parentId: string | null = null;
      for (let depth = 1; depth <= parts.length; depth++) {
        const name = parts.slice(0, depth).join(":");
        const existing = (await backend.listAccounts()).find((a) => a.full_name === name);
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const id = uuidv7();
        const accountType = name.startsWith("Assets") ? "asset" as const
          : name.startsWith("Equity") ? "equity" as const
          : "expense" as const;
        await backend.createAccount({
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: name,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        });
        parentId = id;
      }
    }

    const accounts = await backend.listAccounts();
    const walletAcc = accounts.find((a) => a.full_name === walletAccount)!;
    const externalAcc = accounts.find((a) => a.full_name === externalAccount)!;

    const entryId = uuidv7();
    const source = `etherscan:1:${hash}`;
    const entry: JournalEntry = {
      id: entryId,
      date,
      description: `ETH transfer ${hash.slice(0, 10)}`,
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    const lineItems: LineItem[] = direction === "in"
      ? [
          { id: uuidv7(), journal_entry_id: entryId, account_id: walletAcc.id, currency: "ETH", amount, lot_id: null },
          { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: "ETH", amount: `-${amount}`, lot_id: null },
        ]
      : [
          { id: uuidv7(), journal_entry_id: entryId, account_id: walletAcc.id, currency: "ETH", amount: `-${amount}`, lot_id: null },
          { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: "ETH", amount, lot_id: null },
        ];

    await backend.postJournalEntry(entry, lineItems);
    return { entry, items: lineItems };
  }

  /**
   * Helper: Simulate a CEX deposit/withdrawal entry with txid metadata.
   */
  async function seedCexEntry(
    refid: string,
    txid: string,
    date: string,
    exchangeName: string,
    exchangeId: string,
    asset: string,
    amount: string,
    type: "deposit" | "withdrawal",
  ): Promise<{ entry: JournalEntry; items: LineItem[] }> {
    const assetAccount = `Assets:Exchanges:${exchangeName}:${asset}`;
    const externalAccount = `Equity:Exchanges:${exchangeName}:External`;

    for (const fullName of [assetAccount, externalAccount]) {
      const parts = fullName.split(":");
      let parentId: string | null = null;
      for (let depth = 1; depth <= parts.length; depth++) {
        const name = parts.slice(0, depth).join(":");
        const existing = (await backend.listAccounts()).find((a) => a.full_name === name);
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const id = uuidv7();
        const accountType = name.startsWith("Assets") ? "asset" as const
          : name.startsWith("Equity") ? "equity" as const
          : "expense" as const;
        await backend.createAccount({
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: name,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        });
        parentId = id;
      }
    }

    const accounts = await backend.listAccounts();
    const assetAcc = accounts.find((a) => a.full_name === assetAccount)!;
    const externalAcc = accounts.find((a) => a.full_name === externalAccount)!;

    const entryId = uuidv7();
    const source = `${exchangeId}:${refid}`;
    const entry: JournalEntry = {
      id: entryId,
      date,
      description: `${exchangeName} ${type}: ${amount} ${asset}`,
      status: "confirmed",
      source,
      voided_by: null,
      created_at: date,
    };

    const lineItems: LineItem[] = type === "deposit"
      ? [
          { id: uuidv7(), journal_entry_id: entryId, account_id: assetAcc.id, currency: asset, amount, lot_id: null },
          { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: asset, amount: `-${amount}`, lot_id: null },
        ]
      : [
          { id: uuidv7(), journal_entry_id: entryId, account_id: assetAcc.id, currency: asset, amount: `-${amount}`, lot_id: null },
          { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: asset, amount, lot_id: null },
        ];

    await backend.postJournalEntry(entry, lineItems);
    await backend.setMetadata(entryId, { txid: txid.toLowerCase(), exchange: exchangeId, refid });
    return { entry, items: lineItems };
  }

  it("consolidates matching CEX and Etherscan entries", async () => {
    const txid = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1";

    // Seed both entries independently
    await seedEtherscanEntry(txid, "2024-03-01", "W1", "5", "out");
    await seedCexEntry("D001", txid, "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

    const result = await retroactiveConsolidate(backend, registry);

    expect(result.pairs_found).toBe(1);
    expect(result.pairs_consolidated).toBe(1);
    expect(result.pairs_skipped).toBe(0);

    // Verify: the old entries should be voided
    const allEntries = await backend.queryJournalEntries({});
    const voided = allEntries.filter(([e]) => e.voided_by);
    expect(voided.length).toBe(2); // both old entries voided

    // There should be a new non-voided entry with cex_linked metadata
    const nonVoided = allEntries.filter(([e]) => !e.voided_by);
    expect(nonVoided.length).toBeGreaterThanOrEqual(1);

    // The new entry should have cex_linked metadata
    const newEntry = nonVoided.find(([e]) => e.source.startsWith("etherscan:"));
    expect(newEntry).toBeTruthy();
    const meta = await backend.getMetadata(newEntry![0].id);
    expect(meta["cex_linked"]).toBe("kraken");

    // The new entry should have Assets:Exchanges:Kraken:ETH instead of Equity:*:External:*
    const accounts = await backend.listAccounts();
    const itemAccounts = newEntry![1].map((item) => getAccountName(accounts, item.account_id));
    expect(itemAccounts).toContain("Assets:Exchanges:Kraken:ETH");
    // Should not contain Equity:Ethereum:External:*
    expect(itemAccounts.some((a) => a?.includes("External:0x"))).toBe(false);
  });

  it("is idempotent — already consolidated entries are skipped", async () => {
    const txid = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc2";

    await seedEtherscanEntry(txid, "2024-03-01", "W1", "3", "out");
    await seedCexEntry("D002", txid, "2024-03-01", "Kraken", "kraken", "ETH", "3", "deposit");

    // First consolidation
    const result1 = await retroactiveConsolidate(backend, registry);
    expect(result1.pairs_found).toBe(1);
    expect(result1.pairs_consolidated).toBe(1);

    // Second consolidation — should find nothing
    const result2 = await retroactiveConsolidate(backend, registry);
    expect(result2.pairs_found).toBe(0);
    expect(result2.pairs_consolidated).toBe(0);
  });

  it("matches txids with 0x prefix mismatch", async () => {
    const bareHash = "abc123def456abc123def456abc123def456abc123def456abc123def456abc3";
    const prefixedHash = `0x${bareHash}`;

    // Etherscan uses 0x prefix in source
    await seedEtherscanEntry(prefixedHash, "2024-03-01", "W1", "2", "out");
    // CEX stored without 0x prefix (simulating Kraken)
    await seedCexEntry("D003", bareHash, "2024-03-01", "Kraken", "kraken", "ETH", "2", "deposit");

    const result = await retroactiveConsolidate(backend, registry);

    expect(result.pairs_found).toBe(1);
    expect(result.pairs_consolidated).toBe(1);
  });

  it("dry run reports pairs without modifying", async () => {
    const txid = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc4";

    await seedEtherscanEntry(txid, "2024-03-01", "W1", "1", "out");
    await seedCexEntry("D004", txid, "2024-03-01", "Kraken", "kraken", "ETH", "1", "deposit");

    const result = await retroactiveConsolidate(backend, registry, { dryRun: true });

    expect(result.pairs_found).toBe(1);
    expect(result.pairs_consolidated).toBe(0); // dry run doesn't consolidate

    // Verify nothing was voided
    const allEntries = await backend.queryJournalEntries({});
    const voided = allEntries.filter(([e]) => e.voided_by);
    expect(voided.length).toBe(0);
  });

  it("falls back to direct remap when no raw data available", async () => {
    const txid = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc5";

    // Seed entries but don't store raw transaction data
    await seedEtherscanEntry(txid, "2024-03-01", "W1", "4", "out");
    await seedCexEntry("D005", txid, "2024-03-01", "Kraken", "kraken", "ETH", "4", "deposit");

    // No raw data stored, so handler re-processing can't work
    const result = await retroactiveConsolidate(backend, registry);

    expect(result.pairs_found).toBe(1);
    expect(result.pairs_consolidated).toBe(1);

    // Verify the new entry exists with remapped accounts
    const allEntries = await backend.queryJournalEntries({});
    const nonVoided = allEntries.filter(([e]) => !e.voided_by);
    const newEntry = nonVoided.find(([e]) => e.source.startsWith("etherscan:"));
    expect(newEntry).toBeTruthy();

    const accounts = await backend.listAccounts();
    const itemAccounts = newEntry![1].map((item) => getAccountName(accounts, item.account_id));
    expect(itemAccounts).toContain("Assets:Exchanges:Kraken:ETH");
  });

  it("skips pairs where CEX entry has no asset account", async () => {
    const txid = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc6";

    await seedEtherscanEntry(txid, "2024-03-01", "W1", "1", "out");

    // Create a CEX entry with only equity accounts (no Assets:*)
    // Ensure Equity:Exchanges:Kraken:External exists
    const parentNames = ["Equity", "Equity:Exchanges", "Equity:Exchanges:Kraken", "Equity:Exchanges:Kraken:External"];
    let parentId: string | null = null;
    let equityAccId = "";
    for (const pName of parentNames) {
      const existing = (await backend.listAccounts()).find((a) => a.full_name === pName);
      if (existing) {
        parentId = existing.id;
        equityAccId = existing.id;
        continue;
      }
      const pid = uuidv7();
      await backend.createAccount({
        id: pid,
        parent_id: parentId,
        account_type: "equity",
        name: pName.split(":").pop()!,
        full_name: pName,
        allowed_currencies: [],
        is_postable: true,
        is_archived: false,
        created_at: "2024-03-01",
      });
      parentId = pid;
      equityAccId = pid;
    }

    const entryId = uuidv7();
    const entry: JournalEntry = {
      id: entryId,
      date: "2024-03-01",
      description: "Kraken deposit",
      status: "confirmed",
      source: "kraken:D006",
      voided_by: null,
      created_at: "2024-03-01",
    };

    const lineItems: LineItem[] = [
      { id: uuidv7(), journal_entry_id: entryId, account_id: equityAccId, currency: "ETH", amount: "1", lot_id: null },
      { id: uuidv7(), journal_entry_id: entryId, account_id: equityAccId, currency: "ETH", amount: "-1", lot_id: null },
    ];

    await backend.postJournalEntry(entry, lineItems);
    await backend.setMetadata(entryId, { txid: txid.toLowerCase(), exchange: "kraken", refid: "D006" });

    const result = await retroactiveConsolidate(backend, registry);

    expect(result.pairs_found).toBe(1);
    expect(result.pairs_skipped).toBe(1);
    expect(result.warnings.some((w) => w.includes("No asset account found"))).toBe(true);
  });

  describe("Fallback matching (no txid)", () => {
    /**
     * Helper: Seed a CEX entry WITHOUT txid metadata — simulates the case where
     * Kraken's enrichment API didn't return a txid for this deposit/withdrawal.
     */
    async function seedCexEntryWithoutTxid(
      refid: string,
      date: string,
      exchangeName: string,
      exchangeId: string,
      asset: string,
      amount: string,
      type: "deposit" | "withdrawal",
    ): Promise<{ entry: JournalEntry; items: LineItem[] }> {
      const assetAccount = `Assets:Exchanges:${exchangeName}:${asset}`;
      const externalAccount = `Equity:Exchanges:${exchangeName}:External`;

      for (const fullName of [assetAccount, externalAccount]) {
        const parts = fullName.split(":");
        let parentId: string | null = null;
        for (let depth = 1; depth <= parts.length; depth++) {
          const name = parts.slice(0, depth).join(":");
          const existing = (await backend.listAccounts()).find((a) => a.full_name === name);
          if (existing) {
            parentId = existing.id;
            continue;
          }
          const id = uuidv7();
          const accountType = name.startsWith("Assets") ? "asset" as const
            : name.startsWith("Equity") ? "equity" as const
            : "expense" as const;
          await backend.createAccount({
            id,
            parent_id: parentId,
            account_type: accountType,
            name: parts[depth - 1],
            full_name: name,
            allowed_currencies: [],
            is_postable: true,
            is_archived: false,
            created_at: date,
          });
          parentId = id;
        }
      }

      const accounts = await backend.listAccounts();
      const assetAcc = accounts.find((a) => a.full_name === assetAccount)!;
      const externalAcc = accounts.find((a) => a.full_name === externalAccount)!;

      const entryId = uuidv7();
      const source = `${exchangeId}:${refid}`;
      const entry: JournalEntry = {
        id: entryId,
        date,
        description: `${exchangeName} ${type}: ${amount} ${asset}`,
        status: "confirmed",
        source,
        voided_by: null,
        created_at: date,
      };

      const lineItems: LineItem[] = type === "deposit"
        ? [
            { id: uuidv7(), journal_entry_id: entryId, account_id: assetAcc.id, currency: asset, amount, lot_id: null },
            { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: asset, amount: `-${amount}`, lot_id: null },
          ]
        : [
            { id: uuidv7(), journal_entry_id: entryId, account_id: assetAcc.id, currency: asset, amount: `-${amount}`, lot_id: null },
            { id: uuidv7(), journal_entry_id: entryId, account_id: externalAcc.id, currency: asset, amount, lot_id: null },
          ];

      await backend.postJournalEntry(entry, lineItems);
      // No txid metadata — only exchange and refid
      await backend.setMetadata(entryId, { exchange: exchangeId, refid });
      return { entry, items: lineItems };
    }

    it("matches by amount+currency+date when CEX entry has no txid", async () => {
      const hash = "0xfb0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: user sends 5 ETH out from wallet (deposit to exchange)
      await seedEtherscanEntry(hash, "2024-03-01", "W1", "5", "out");
      // CEX: receives 5 ETH deposit — no txid metadata
      await seedCexEntryWithoutTxid("D010", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(1);
      expect(result.pairs_consolidated).toBe(1);

      // Verify the new entry has CEX asset account instead of External
      const allEntries = await backend.queryJournalEntries({});
      const nonVoided = allEntries.filter(([e]) => !e.voided_by);
      const consolidated = nonVoided.find(([e]) => e.source.startsWith("etherscan:"));
      expect(consolidated).toBeTruthy();

      const accounts = await backend.listAccounts();
      const itemAccounts = consolidated![1].map((item) => getAccountName(accounts, item.account_id));
      expect(itemAccounts).toContain("Assets:Exchanges:Kraken:ETH");
      expect(itemAccounts.some((a) => a?.includes("External:0x"))).toBe(false);
    });

    it("matches withdrawal (CEX sends out, Etherscan wallet receives)", async () => {
      const hash = "0xfc0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: user receives 3 ETH into wallet (withdrawal from exchange)
      await seedEtherscanEntry(hash, "2024-04-01", "W1", "3", "in");
      // CEX: sends 3 ETH withdrawal — no txid metadata
      await seedCexEntryWithoutTxid("W010", "2024-04-01", "Kraken", "kraken", "ETH", "3", "withdrawal");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(1);
      expect(result.pairs_consolidated).toBe(1);
    });

    it("tolerates small amount difference (gas fees)", async () => {
      const hash = "0xfd0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: user sends 5.02 ETH out (includes gas)
      await seedEtherscanEntry(hash, "2024-03-01", "W1", "5.02", "out");
      // CEX: receives 5 ETH deposit — 0.4% difference, within 5% threshold
      await seedCexEntryWithoutTxid("D011", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(1);
      expect(result.pairs_consolidated).toBe(1);
    });

    it("rejects amount difference above 5%", async () => {
      const hash = "0xfe0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: user sends 10 ETH out
      await seedEtherscanEntry(hash, "2024-03-01", "W1", "10", "out");
      // CEX: receives 5 ETH deposit — 100% difference, way above threshold
      await seedCexEntryWithoutTxid("D012", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(0);
      expect(result.pairs_consolidated).toBe(0);
    });

    it("rejects date difference above 2 days", async () => {
      const hash = "0xff0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: March 1
      await seedEtherscanEntry(hash, "2024-03-01", "W1", "5", "out");
      // CEX: March 5 — 4 days apart, above 2-day threshold
      await seedCexEntryWithoutTxid("D013", "2024-03-05", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(0);
    });

    it("rejects direction mismatch", async () => {
      const hash = "0xfa0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan: user receives ETH (incoming)
      await seedEtherscanEntry(hash, "2024-03-01", "W1", "5", "in");
      // CEX: also a deposit (incoming) — directions don't match for consolidation
      await seedCexEntryWithoutTxid("D014", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      expect(result.pairs_found).toBe(0);
    });

    it("prefers txid match over fallback match", async () => {
      const txid = "0xab0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      // Etherscan entry with known hash
      await seedEtherscanEntry(txid, "2024-03-01", "W1", "5", "out");
      // CEX entry WITH txid — should match by txid
      await seedCexEntry("D015", txid, "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");
      // CEX entry WITHOUT txid — same amount/date, should NOT also match
      await seedCexEntryWithoutTxid("D016", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result = await retroactiveConsolidate(backend, registry);

      // Should find exactly 1 pair (the txid match), not 2
      expect(result.pairs_found).toBe(1);
      expect(result.pairs_consolidated).toBe(1);
      expect(result.pairs[0].txid).toBe(txid);
    });

    it("fallback is idempotent", async () => {
      const hash = "0xac0011223344556677889900aabbccddeeff00112233445566778899aabbccdd";

      await seedEtherscanEntry(hash, "2024-03-01", "W1", "5", "out");
      await seedCexEntryWithoutTxid("D017", "2024-03-01", "Kraken", "kraken", "ETH", "5", "deposit");

      const result1 = await retroactiveConsolidate(backend, registry);
      expect(result1.pairs_found).toBe(1);
      expect(result1.pairs_consolidated).toBe(1);

      // Second run should find nothing
      const result2 = await retroactiveConsolidate(backend, registry);
      expect(result2.pairs_found).toBe(0);
      expect(result2.pairs_consolidated).toBe(0);
    });
  });
});
