import { describe, it, expect } from "vitest";
import { createTestBackend } from "./helpers.js";
import {
  createDefaultAccounts,
  DEFAULT_ACCOUNTS,
  type DefaultAccountSet,
} from "$lib/accounts/defaults.js";

describe("createDefaultAccounts", () => {
  const sets: DefaultAccountSet[] = ["minimal", "standard", "comprehensive"];

  for (const set of sets) {
    it(`creates ${set} set on an empty backend`, async () => {
      const backend = await createTestBackend();
      const result = await createDefaultAccounts(backend, set);

      expect(result.skipped).toBe(0);
      expect(result.created).toBeGreaterThan(0);

      const accounts = await backend.listAccounts();
      // Every defined account should exist
      for (const def of DEFAULT_ACCOUNTS[set]) {
        const found = accounts.find((a) => a.full_name === def.full_name);
        expect(found, `missing account: ${def.full_name}`).toBeDefined();
        expect(found!.is_postable).toBe(def.is_postable);
      }
    });
  }

  it("builds correct parent hierarchy", async () => {
    const backend = await createTestBackend();
    await createDefaultAccounts(backend, "minimal");

    const accounts = await backend.listAccounts();
    const byName = new Map(accounts.map((a) => [a.full_name, a]));

    // Check that Expenses:Housing:Rent has Expenses:Housing as parent
    const rent = byName.get("Expenses:Housing:Rent");
    const housing = byName.get("Expenses:Housing");
    expect(rent).toBeDefined();
    expect(housing).toBeDefined();
    expect(rent!.parent_id).toBe(housing!.id);

    // Check that Expenses:Housing has Expenses as parent
    const expenses = byName.get("Expenses");
    expect(housing!.parent_id).toBe(expenses!.id);

    // Check top-level has null parent
    expect(expenses!.parent_id).toBeNull();
  });

  it("infers correct account types", async () => {
    const backend = await createTestBackend();
    await createDefaultAccounts(backend, "minimal");

    const accounts = await backend.listAccounts();
    const byName = new Map(accounts.map((a) => [a.full_name, a]));

    expect(byName.get("Assets")!.account_type).toBe("asset");
    expect(byName.get("Liabilities")!.account_type).toBe("liability");
    expect(byName.get("Equity")!.account_type).toBe("equity");
    expect(byName.get("Income")!.account_type).toBe("revenue");
    expect(byName.get("Expenses")!.account_type).toBe("expense");
    expect(byName.get("Assets:Cash")!.account_type).toBe("asset");
    expect(byName.get("Expenses:Groceries")!.account_type).toBe("expense");
  });

  it("is idempotent — running twice skips all on second run", async () => {
    const backend = await createTestBackend();
    const first = await createDefaultAccounts(backend, "standard");
    const accountsAfterFirst = await backend.listAccounts();

    const second = await createDefaultAccounts(backend, "standard");
    const accountsAfterSecond = await backend.listAccounts();

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(DEFAULT_ACCOUNTS.standard.length);
    expect(accountsAfterSecond.length).toBe(accountsAfterFirst.length);
  });

  it("does not overwrite existing accounts", async () => {
    const backend = await createTestBackend();

    // Pre-create Assets:Cash as postable with a specific date
    const { v7: uuidv7 } = await import("uuid");
    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId,
      parent_id: null,
      account_type: "asset",
      name: "Assets",
      full_name: "Assets",
      allowed_currencies: [],
      is_postable: false,
      is_archived: false,
      created_at: "2020-01-01",
    });

    const cashId = uuidv7();
    await backend.createAccount({
      id: cashId,
      parent_id: assetsId,
      account_type: "asset",
      name: "Cash",
      full_name: "Assets:Cash",
      allowed_currencies: ["USD"],
      is_postable: true,
      is_archived: false,
      created_at: "2020-01-01",
    });

    await createDefaultAccounts(backend, "minimal");

    // The original Assets:Cash should still have its original properties
    const cash = await backend.getAccount(cashId);
    expect(cash).toBeDefined();
    expect(cash!.created_at).toBe("2020-01-01");
    expect(cash!.allowed_currencies).toEqual(["USD"]);
  });

  it("standard is a superset of minimal", () => {
    const minimalNames = new Set(DEFAULT_ACCOUNTS.minimal.map((d) => d.full_name));
    for (const name of minimalNames) {
      expect(
        DEFAULT_ACCOUNTS.standard.some((d) => d.full_name === name),
        `standard should contain ${name}`,
      ).toBe(true);
    }
  });

  it("comprehensive is a superset of standard", () => {
    const standardNames = new Set(DEFAULT_ACCOUNTS.standard.map((d) => d.full_name));
    for (const name of standardNames) {
      expect(
        DEFAULT_ACCOUNTS.comprehensive.some((d) => d.full_name === name),
        `comprehensive should contain ${name}`,
      ).toBe(true);
    }
  });
});
