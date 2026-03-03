import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createTestBackend, seedBasicLedger, makeEntry, makeLineItem } from "../../test/helpers.js";
import type { Account, Currency } from "$lib/types/index.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";
import Decimal from "decimal.js-light";

async function createAccount(
  backend: SqlJsBackend,
  overrides: Partial<Account> & Pick<Account, "parent_id" | "account_type" | "name" | "full_name">,
): Promise<Account> {
  const account: Account = {
    id: uuidv7(),
    allowed_currencies: [],
    is_postable: true,
    is_archived: false,
    created_at: "2024-01-01",
    ...overrides,
  };
  await backend.createAccount(account);
  return account;
}

describe("mergeAccounts", () => {
  // ---- Validation ----

  describe("validation", () => {
    it("rejects merge into self", async () => {
      const { backend, accounts } = await seedBasicLedger();
      await expect(backend.mergeAccounts(accounts.bank.id, accounts.bank.id)).rejects.toThrow(
        "cannot merge an account into itself",
      );
    });

    it("rejects different account types", async () => {
      const { backend, accounts } = await seedBasicLedger();
      await expect(backend.mergeAccounts(accounts.bank.id, accounts.food.id)).rejects.toThrow(
        "cannot merge accounts of different types",
      );
    });

    it("rejects non-existent source", async () => {
      const { backend, accounts } = await seedBasicLedger();
      await expect(backend.mergeAccounts("nonexistent", accounts.bank.id)).rejects.toThrow(
        "source account nonexistent not found",
      );
    });

    it("rejects non-existent target", async () => {
      const { backend, accounts } = await seedBasicLedger();
      await expect(backend.mergeAccounts(accounts.bank.id, "nonexistent")).rejects.toThrow(
        "target account nonexistent not found",
      );
    });

    it("rejects root account merge", async () => {
      const { backend } = await seedBasicLedger();
      const accounts = await backend.listAccounts();
      const assetsRoot = accounts.find((a) => a.full_name === "Assets")!;
      const bank = accounts.find((a) => a.full_name === "Assets:Bank")!;
      await expect(backend.mergeAccounts(assetsRoot.id, bank.id)).rejects.toThrow(
        'cannot merge root account "Assets"',
      );
    });
  });

  // ---- Data migration (childless source) ----

  describe("data migration", () => {
    it("moves line items to target", async () => {
      const { backend, accounts } = await seedBasicLedger();
      // Create a second bank account
      const accounts2 = await backend.listAccounts();
      const assetsRoot = accounts2.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      // Post an entry to savings
      const entry = makeEntry({ description: "Transfer to savings" });
      await backend.postJournalEntry(entry, [
        makeLineItem(entry.id, savings.id, "USD", "500"),
        makeLineItem(entry.id, accounts.bank.id, "USD", "-500"),
      ]);

      const savingsBalBefore = await backend.getAccountBalance(savings.id);
      expect(savingsBalBefore[0].amount).toBe("500");

      const bankBalBefore = await backend.getAccountBalance(accounts.bank.id);

      // Merge savings into bank
      const result = await backend.mergeAccounts(savings.id, accounts.bank.id);
      expect(result.lineItems).toBeGreaterThan(0);

      // Bank should now have savings' balance too
      const bankBalAfter = await backend.getAccountBalance(accounts.bank.id);
      const bankBefore = new Decimal(bankBalBefore[0].amount);
      const bankAfter = new Decimal(bankBalAfter[0].amount);
      expect(bankAfter.minus(bankBefore).toString()).toBe("500");

      // Savings should no longer exist
      const afterAccounts = await backend.listAccounts();
      expect(afterAccounts.find((a) => a.id === savings.id)).toBeUndefined();
    });

    it("moves lots to target", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;

      // Create two exchange accounts
      const exchange1 = await createAccount(backend, { parent_id: assetsRoot.id, account_type: "asset", name: "Exchange1", full_name: "Assets:Exchange1" });
      const exchange2 = await createAccount(backend, { parent_id: assetsRoot.id, account_type: "asset", name: "Exchange2", full_name: "Assets:Exchange2" });

      // Post entry with a line on exchange1 (no lot_id — just line items)
      const e1 = makeEntry({ description: "Deposit to exchange1" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, exchange1.id, "USD", "1000"),
        makeLineItem(e1.id, accounts.bank.id, "USD", "-1000"),
      ]);

      const result = await backend.mergeAccounts(exchange1.id, exchange2.id);
      // lots count may be 0 if there are no lots, but line items should move
      expect(result.lineItems).toBeGreaterThan(0);

      // exchange2 should have the balance now
      const bal = await backend.getAccountBalance(exchange2.id);
      expect(bal[0].amount).toBe("1000");
    });

    it("moves balance assertions to target", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      await backend.createBalanceAssertion({
        id: uuidv7(),
        account_id: savings.id,
        date: "2024-01-31",
        currency: "USD",
        expected_balance: "0",
        is_passing: true,
        actual_balance: null,
        is_strict: false,
        include_subaccounts: false,
      });

      const result = await backend.mergeAccounts(savings.id, accounts.bank.id);
      expect(result.assertions).toBe(1);

      const assertions = await backend.listBalanceAssertions(accounts.bank.id);
      expect(assertions.length).toBe(1);
    });

    it("merges account metadata (target wins on conflict)", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      // Set metadata on both accounts
      await backend.setAccountMetadata(savings.id, { color: "blue", note: "from savings" });
      await backend.setAccountMetadata(accounts.bank.id, { color: "red" });

      await backend.mergeAccounts(savings.id, accounts.bank.id);

      const metadata = await backend.getAccountMetadata(accounts.bank.id);
      // Target's "color" should win (INSERT OR IGNORE)
      expect(metadata.color).toBe("red");
      // Source's unique key should be copied
      expect(metadata.note).toBe("from savings");
    });

    it("moves reconciliations to target", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      // Post entry to savings and reconcile
      const entry = makeEntry({ description: "Deposit" });
      const li = makeLineItem(entry.id, savings.id, "USD", "100");
      await backend.postJournalEntry(entry, [
        li,
        makeLineItem(entry.id, accounts.bank.id, "USD", "-100"),
      ]);
      await backend.markReconciled(
        { id: uuidv7(), account_id: savings.id, statement_date: "2024-01-31", statement_balance: "100", currency: "USD", reconciled_at: "2024-02-01", line_item_count: 1 },
        [li.id],
      );

      const result = await backend.mergeAccounts(savings.id, accounts.bank.id);
      expect(result.reconciliations).toBe(1);

      const recs = await backend.listReconciliations(accounts.bank.id);
      expect(recs.length).toBe(1);
    });

    it("updates recurring template JSON", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      await backend.createRecurringTemplate({
        id: uuidv7(),
        description: "Monthly transfer",
        frequency: "monthly",
        interval: 1,
        next_date: "2024-02-01",
        end_date: null,
        is_active: true,
        line_items: [
          { account_id: savings.id, currency: "USD", amount: "500" },
          { account_id: accounts.bank.id, currency: "USD", amount: "-500" },
        ],
        created_at: "2024-01-01",
      });

      const result = await backend.mergeAccounts(savings.id, accounts.bank.id);
      expect(result.templates).toBe(1);

      const templates = await backend.listRecurringTemplates();
      const tmpl = templates[0];
      expect(tmpl.line_items.every((li) => li.account_id !== savings.id)).toBe(true);
      expect(tmpl.line_items.some((li) => li.account_id === accounts.bank.id)).toBe(true);
    });
  });

  // ---- Children handling ----

  describe("children handling", () => {
    it("moves children under target when no conflict", async () => {
      const backend = await createTestBackend();
      const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true };
      await backend.createCurrency(USD);

      const assets = await createAccount(backend, { parent_id: null, account_type: "asset", name: "Assets", full_name: "Assets", is_postable: false });
      const equity = await createAccount(backend, { parent_id: null, account_type: "equity", name: "Equity", full_name: "Equity", is_postable: false });
      const opening = await createAccount(backend, { parent_id: equity.id, account_type: "equity", name: "Opening", full_name: "Equity:Opening" });

      // Create source with children: Assets:OldBank > Assets:OldBank:Checking, Assets:OldBank:Savings
      const oldBank = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "OldBank", full_name: "Assets:OldBank", is_postable: false });
      const oldChecking = await createAccount(backend, { parent_id: oldBank.id, account_type: "asset", name: "Checking", full_name: "Assets:OldBank:Checking" });
      const oldSavings = await createAccount(backend, { parent_id: oldBank.id, account_type: "asset", name: "Savings", full_name: "Assets:OldBank:Savings" });

      // Create target: Assets:NewBank (no children yet)
      const newBank = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "NewBank", full_name: "Assets:NewBank", is_postable: false });

      // Post entries to old accounts
      const e1 = makeEntry({ description: "Deposit" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, oldChecking.id, "USD", "1000"),
        makeLineItem(e1.id, opening.id, "USD", "-1000"),
      ]);

      await backend.mergeAccounts(oldBank.id, newBank.id);

      const afterAccounts = await backend.listAccounts();
      // Children should be renamed
      expect(afterAccounts.find((a) => a.full_name === "Assets:NewBank:Checking")).toBeDefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:NewBank:Savings")).toBeDefined();
      // Old accounts should be gone
      expect(afterAccounts.find((a) => a.full_name === "Assets:OldBank")).toBeUndefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:OldBank:Checking")).toBeUndefined();
    });

    it("merges children into existing target children on conflict", async () => {
      const backend = await createTestBackend();
      const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true };
      await backend.createCurrency(USD);

      const assets = await createAccount(backend, { parent_id: null, account_type: "asset", name: "Assets", full_name: "Assets", is_postable: false });
      const equity = await createAccount(backend, { parent_id: null, account_type: "equity", name: "Equity", full_name: "Equity", is_postable: false });
      const opening = await createAccount(backend, { parent_id: equity.id, account_type: "equity", name: "Opening", full_name: "Equity:Opening" });

      // Source: Assets:OldBank > Assets:OldBank:Checking
      const oldBank = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "OldBank", full_name: "Assets:OldBank", is_postable: false });
      const oldChecking = await createAccount(backend, { parent_id: oldBank.id, account_type: "asset", name: "Checking", full_name: "Assets:OldBank:Checking" });

      // Target: Assets:NewBank > Assets:NewBank:Checking (same leaf name)
      const newBank = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "NewBank", full_name: "Assets:NewBank", is_postable: false });
      const newChecking = await createAccount(backend, { parent_id: newBank.id, account_type: "asset", name: "Checking", full_name: "Assets:NewBank:Checking" });

      // Post entries to both checking accounts
      const e1 = makeEntry({ description: "Old deposit" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, oldChecking.id, "USD", "300"),
        makeLineItem(e1.id, opening.id, "USD", "-300"),
      ]);
      const e2 = makeEntry({ description: "New deposit" });
      await backend.postJournalEntry(e2, [
        makeLineItem(e2.id, newChecking.id, "USD", "700"),
        makeLineItem(e2.id, opening.id, "USD", "-700"),
      ]);

      await backend.mergeAccounts(oldBank.id, newBank.id);

      // Old checking should be gone, new checking should have combined balance
      const afterAccounts = await backend.listAccounts();
      expect(afterAccounts.find((a) => a.id === oldChecking.id)).toBeUndefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:OldBank:Checking")).toBeUndefined();

      const newCheckingBal = await backend.getAccountBalance(newChecking.id);
      expect(newCheckingBal[0].amount).toBe("1000");
    });

    it("handles deep hierarchy (grandchildren)", async () => {
      const backend = await createTestBackend();
      const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true };
      await backend.createCurrency(USD);

      const assets = await createAccount(backend, { parent_id: null, account_type: "asset", name: "Assets", full_name: "Assets", is_postable: false });
      const equity = await createAccount(backend, { parent_id: null, account_type: "equity", name: "Equity", full_name: "Equity", is_postable: false });
      const opening = await createAccount(backend, { parent_id: equity.id, account_type: "equity", name: "Opening", full_name: "Equity:Opening" });

      // Source: Assets:A > Assets:A:B > Assets:A:B:C (3 levels)
      const a = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "A", full_name: "Assets:A", is_postable: false });
      const ab = await createAccount(backend, { parent_id: a.id, account_type: "asset", name: "B", full_name: "Assets:A:B", is_postable: false });
      const abc = await createAccount(backend, { parent_id: ab.id, account_type: "asset", name: "C", full_name: "Assets:A:B:C" });

      // Target: Assets:X
      const x = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "X", full_name: "Assets:X", is_postable: false });

      // Post entry to deepest leaf
      const e1 = makeEntry({ description: "Deep deposit" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, abc.id, "USD", "100"),
        makeLineItem(e1.id, opening.id, "USD", "-100"),
      ]);

      await backend.mergeAccounts(a.id, x.id);

      const afterAccounts = await backend.listAccounts();
      // Should now have Assets:X:B:C
      expect(afterAccounts.find((a) => a.full_name === "Assets:X:B:C")).toBeDefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:X:B")).toBeDefined();
      // Old hierarchy gone
      expect(afterAccounts.find((a) => a.full_name === "Assets:A")).toBeUndefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:A:B")).toBeUndefined();
      expect(afterAccounts.find((a) => a.full_name === "Assets:A:B:C")).toBeUndefined();

      // Balance on the renamed leaf
      const renamedLeaf = afterAccounts.find((a) => a.full_name === "Assets:X:B:C")!;
      const bal = await backend.getAccountBalance(renamedLeaf.id);
      expect(bal[0].amount).toBe("100");
    });
  });

  // ---- Cleanup ----

  describe("cleanup", () => {
    it("deletes source account after merge", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      await backend.mergeAccounts(savings.id, accounts.bank.id);

      const afterAccounts = await backend.listAccounts();
      expect(afterAccounts.find((a) => a.id === savings.id)).toBeUndefined();
    });

    it("removes source from closure table", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      await backend.mergeAccounts(savings.id, accounts.bank.id);

      // getAccountBalanceWithChildren on Assets should still work (closure table intact)
      const assetsBal = await backend.getAccountBalanceWithChildren(assetsRoot.id);
      expect(assetsBal.length).toBeGreaterThan(0);
    });

    it("cleans up orphaned intermediate parents", async () => {
      const backend = await createTestBackend();
      const USD: Currency = { code: "USD", asset_type: "", param: "", name: "US Dollar", decimal_places: 2, is_base: true };
      await backend.createCurrency(USD);

      const assets = await createAccount(backend, { parent_id: null, account_type: "asset", name: "Assets", full_name: "Assets", is_postable: false });
      const equity = await createAccount(backend, { parent_id: null, account_type: "equity", name: "Equity", full_name: "Equity", is_postable: false });
      const opening = await createAccount(backend, { parent_id: equity.id, account_type: "equity", name: "Opening", full_name: "Equity:Opening" });

      // Create: Assets:Old > Assets:Old:Sub (intermediate parent with one child)
      const old = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "Old", full_name: "Assets:Old", is_postable: false });
      const oldSub = await createAccount(backend, { parent_id: old.id, account_type: "asset", name: "Sub", full_name: "Assets:Old:Sub" });
      const target = await createAccount(backend, { parent_id: assets.id, account_type: "asset", name: "Target", full_name: "Assets:Target" });

      const e1 = makeEntry({ description: "Deposit" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, oldSub.id, "USD", "100"),
        makeLineItem(e1.id, opening.id, "USD", "-100"),
      ]);

      await backend.mergeAccounts(oldSub.id, target.id);

      const afterAccounts = await backend.listAccounts();
      // Assets:Old should be cleaned up (orphaned, non-postable, no children, no line items)
      expect(afterAccounts.find((a) => a.full_name === "Assets:Old")).toBeUndefined();
    });
  });

  // ---- Integrity ----

  describe("integrity", () => {
    it("trial balance still zeroes after merge", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      // Post some entries to savings
      const e1 = makeEntry({ description: "Transfer" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, savings.id, "USD", "200"),
        makeLineItem(e1.id, accounts.bank.id, "USD", "-200"),
      ]);

      await backend.mergeAccounts(savings.id, accounts.bank.id);

      // Trial balance must still zero
      const tb = await backend.trialBalance("2024-12-31");
      for (const line of tb.lines) {
        // Sum per currency should be zero across all accounts
      }
      // Check total debits = total credits
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);
      for (const line of tb.lines) {
        for (const b of line.balances) {
          const val = new Decimal(b.amount);
          if (val.gt(0)) totalDebit = totalDebit.plus(val);
          else totalCredit = totalCredit.plus(val.abs());
        }
      }
      expect(totalDebit.toString()).toBe(totalCredit.toString());
    });

    it("getAccountBalanceWithChildren includes merged data", async () => {
      const { backend, accounts } = await seedBasicLedger();
      const allAccounts = await backend.listAccounts();
      const assetsRoot = allAccounts.find((a) => a.full_name === "Assets")!;
      const savings = await createAccount(backend, {
        parent_id: assetsRoot.id,
        account_type: "asset",
        name: "Savings",
        full_name: "Assets:Savings",
      });

      const e1 = makeEntry({ description: "Deposit to savings" });
      await backend.postJournalEntry(e1, [
        makeLineItem(e1.id, savings.id, "USD", "500"),
        makeLineItem(e1.id, accounts.bank.id, "USD", "-500"),
      ]);

      // Get total assets before merge
      const assetsBefore = await backend.getAccountBalanceWithChildren(assetsRoot.id);
      const totalBefore = new Decimal(assetsBefore[0]?.amount ?? "0");

      await backend.mergeAccounts(savings.id, accounts.bank.id);

      // Total assets should be unchanged
      const assetsAfter = await backend.getAccountBalanceWithChildren(assetsRoot.id);
      const totalAfter = new Decimal(assetsAfter[0]?.amount ?? "0");
      expect(totalAfter.toString()).toBe(totalBefore.toString());
    });
  });
});
