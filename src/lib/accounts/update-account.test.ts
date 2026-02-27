import { describe, it, expect } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { seedBasicLedger, makeEntry, makeLineItem } from "../../test/helpers.js";
import type { Account } from "$lib/types/index.js";

describe("updateAccount", () => {
  it("renames an account and updates full_name, name, parent_id", async () => {
    const { backend, accounts } = await seedBasicLedger();
    // Rename Assets:Bank → Assets:Savings
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:Savings" });

    const updated = await backend.getAccount(accounts.bank.id);
    expect(updated).not.toBeNull();
    expect(updated!.full_name).toBe("Assets:Savings");
    expect(updated!.name).toBe("Savings");
  });

  it("renames an account with children and updates descendants recursively", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Create Assets:Bank:Checking under Assets:Bank
    const checking: Account = {
      id: uuidv7(),
      parent_id: accounts.bank.id,
      account_type: "asset",
      name: "Checking",
      full_name: "Assets:Bank:Checking",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(checking);

    // Create Assets:Bank:Checking:Sub under that
    const sub: Account = {
      id: uuidv7(),
      parent_id: checking.id,
      account_type: "asset",
      name: "Sub",
      full_name: "Assets:Bank:Checking:Sub",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(sub);

    // Rename Assets:Bank → Assets:MyBank
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:MyBank" });

    const updatedBank = await backend.getAccount(accounts.bank.id);
    expect(updatedBank!.full_name).toBe("Assets:MyBank");

    const updatedChecking = await backend.getAccount(checking.id);
    expect(updatedChecking!.full_name).toBe("Assets:MyBank:Checking");

    const updatedSub = await backend.getAccount(sub.id);
    expect(updatedSub!.full_name).toBe("Assets:MyBank:Checking:Sub");
  });

  it("creates intermediate parent accounts when needed", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Rename Assets:Bank → Assets:Financial:Bank:Main
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:Financial:Bank:Main" });

    const updated = await backend.getAccount(accounts.bank.id);
    expect(updated!.full_name).toBe("Assets:Financial:Bank:Main");

    // Check intermediate accounts were created
    const all = await backend.listAccounts();
    const financial = all.find((a) => a.full_name === "Assets:Financial");
    expect(financial).toBeDefined();
    expect(financial!.is_postable).toBe(false);

    const financialBank = all.find((a) => a.full_name === "Assets:Financial:Bank");
    expect(financialBank).toBeDefined();
    expect(financialBank!.is_postable).toBe(false);
    expect(financialBank!.parent_id).toBe(financial!.id);
  });

  it("cleans up orphaned old intermediate accounts", async () => {
    const { backend } = await seedBasicLedger();

    // Create a deeper hierarchy: Assets:Old:Sub:Leaf
    const oldParent: Account = {
      id: uuidv7(),
      parent_id: null,
      account_type: "asset",
      name: "Old",
      full_name: "Assets:Old",
      allowed_currencies: [],
      is_postable: false,
      is_archived: false,
      created_at: "2024-01-01",
    };
    // Need Assets root
    const allAccounts = await backend.listAccounts();
    const assetsRoot = allAccounts.find((a) => a.full_name === "Assets");
    oldParent.parent_id = assetsRoot!.id;
    await backend.createAccount(oldParent);

    const subParent: Account = {
      id: uuidv7(),
      parent_id: oldParent.id,
      account_type: "asset",
      name: "Sub",
      full_name: "Assets:Old:Sub",
      allowed_currencies: [],
      is_postable: false,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(subParent);

    const leaf: Account = {
      id: uuidv7(),
      parent_id: subParent.id,
      account_type: "asset",
      name: "Leaf",
      full_name: "Assets:Old:Sub:Leaf",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(leaf);

    // Rename leaf to a completely new path
    await backend.updateAccount(leaf.id, { full_name: "Assets:New:Leaf" });

    const after = await backend.listAccounts();
    // Old intermediates with no children or line items should be cleaned up
    expect(after.find((a) => a.full_name === "Assets:Old:Sub")).toBeUndefined();
    expect(after.find((a) => a.full_name === "Assets:Old")).toBeUndefined();
    // New intermediate should exist
    expect(after.find((a) => a.full_name === "Assets:New")).toBeDefined();
  });

  it("rejects renaming to a different account type", async () => {
    const { backend, accounts } = await seedBasicLedger();

    await expect(
      backend.updateAccount(accounts.bank.id, { full_name: "Expenses:Bank" }),
    ).rejects.toThrow(/cannot change account type/);
  });

  it("rejects renaming to an existing full_name", async () => {
    const { backend, accounts } = await seedBasicLedger();

    await expect(
      backend.updateAccount(accounts.bank.id, { full_name: "Expenses:Food" }),
    ).rejects.toThrow(); // Fails on type constraint or duplicate
  });

  it("rejects renaming a root account", async () => {
    const { backend } = await seedBasicLedger();
    const all = await backend.listAccounts();
    const assetsRoot = all.find((a) => a.full_name === "Assets" && a.parent_id === null);
    expect(assetsRoot).toBeDefined();

    await expect(
      backend.updateAccount(assetsRoot!.id, { full_name: "MyAssets" }),
    ).rejects.toThrow(/cannot edit root account/);
  });

  it("rejects renaming to a single segment (root-like)", async () => {
    const { backend, accounts } = await seedBasicLedger();

    await expect(
      backend.updateAccount(accounts.bank.id, { full_name: "Bank" }),
    ).rejects.toThrow(/must contain at least two segments/);
  });

  it("toggles is_postable", async () => {
    const { backend, accounts } = await seedBasicLedger();

    expect(accounts.bank.is_postable).toBe(true);
    await backend.updateAccount(accounts.bank.id, { is_postable: false });

    const updated = await backend.getAccount(accounts.bank.id);
    expect(updated!.is_postable).toBe(false);

    // Toggle back
    await backend.updateAccount(accounts.bank.id, { is_postable: true });
    const restored = await backend.getAccount(accounts.bank.id);
    expect(restored!.is_postable).toBe(true);
  });

  it("preserves line item references after rename", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Get balance before rename
    const balanceBefore = await backend.getAccountBalance(accounts.bank.id);

    // Rename
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:MainBank" });

    // Balance should be preserved (line items reference by ID)
    const balanceAfter = await backend.getAccountBalance(accounts.bank.id);
    expect(balanceAfter).toEqual(balanceBefore);
  });

  it("preserves balance with children after rename", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Get parent balance before
    const all = await backend.listAccounts();
    const assetsRoot = all.find((a) => a.full_name === "Assets")!;
    const balanceBefore = await backend.getAccountBalanceWithChildren(assetsRoot.id);

    // Rename bank
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:Savings" });

    // Subtree balance should still work
    const balanceAfter = await backend.getAccountBalanceWithChildren(assetsRoot.id);
    expect(balanceAfter).toEqual(balanceBefore);
  });

  it("can rename and toggle postable in one call", async () => {
    const { backend, accounts } = await seedBasicLedger();

    await backend.updateAccount(accounts.bank.id, {
      full_name: "Assets:MainBank",
      is_postable: false,
    });

    const updated = await backend.getAccount(accounts.bank.id);
    expect(updated!.full_name).toBe("Assets:MainBank");
    expect(updated!.is_postable).toBe(false);
  });

  it("no-ops when no changes provided", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Same values as current → should not throw
    await backend.updateAccount(accounts.bank.id, {
      full_name: "Assets:Bank",
      is_postable: true,
    });

    const updated = await backend.getAccount(accounts.bank.id);
    expect(updated!.full_name).toBe("Assets:Bank");
    expect(updated!.is_postable).toBe(true);
  });

  it("throws for non-existent account", async () => {
    const { backend } = await seedBasicLedger();
    await expect(
      backend.updateAccount("non-existent-id", { full_name: "Assets:Nope" }),
    ).rejects.toThrow(/not found/);
  });

  it("updates closure table correctly after rename (balanceWithChildren works)", async () => {
    const { backend, accounts, currencies } = await seedBasicLedger();

    // Create Assets:Bank:Sub
    const sub: Account = {
      id: uuidv7(),
      parent_id: accounts.bank.id,
      account_type: "asset",
      name: "Sub",
      full_name: "Assets:Bank:Sub",
      allowed_currencies: [],
      is_postable: true,
      is_archived: false,
      created_at: "2024-01-01",
    };
    await backend.createAccount(sub);

    // Post entry to sub account
    const entryId = uuidv7();
    const entry = makeEntry({ id: entryId, description: "Sub deposit" });
    const items = [
      makeLineItem(entryId, sub.id, "USD", "500"),
      makeLineItem(entryId, accounts.salary.id, "USD", "-500"),
    ];
    await backend.postJournalEntry(entry, items);

    // Rename Assets:Bank → Assets:MainBank
    await backend.updateAccount(accounts.bank.id, { full_name: "Assets:MainBank" });

    // balanceWithChildren on Assets:MainBank should include sub's balance
    const balance = await backend.getAccountBalanceWithChildren(accounts.bank.id);
    const usdBalance = balance.find((b) => b.currency === "USD");
    expect(usdBalance).toBeDefined();
    // Original bank had 3950 (1000 + 3000 - 50), plus sub's 500 = 4450
    expect(usdBalance!.amount).toBe("4450");
  });
});
