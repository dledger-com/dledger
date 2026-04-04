import { describe, it, expect } from "vitest";
import { importLedger } from "$lib/browser-ledger-file.js";
import { createTestBackend } from "./helpers.js";

/**
 * Regression test: importing a ledger that posts to accounts previously
 * created as non-postable (e.g. by renameAccountPrefix or mergeAccount)
 * should automatically make them postable instead of failing with
 * "account X is not postable".
 */
describe("import into non-postable accounts", () => {
  it("should make non-postable accounts postable during beancount import", async () => {
    const backend = await createTestBackend();

    // Pre-create the account hierarchy with Assets:Bank as non-postable
    // (simulates what renameAccountPrefix or mergeAccount would do)
    const { v7: uuidv7 } = await import("uuid");

    await backend.createCurrency({
      code: "USD", asset_type: "",
      name: "US Dollar", decimal_places: 2,
    });

    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId, parent_id: null, account_type: "asset",
      name: "Assets", full_name: "Assets",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const bankId = uuidv7();
    await backend.createAccount({
      id: bankId, parent_id: assetsId, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const expensesId = uuidv7();
    await backend.createAccount({
      id: expensesId, parent_id: null, account_type: "expense",
      name: "Expenses", full_name: "Expenses",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const foodId = uuidv7();
    await backend.createAccount({
      id: foodId, parent_id: expensesId, account_type: "expense",
      name: "Food", full_name: "Expenses:Food",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    // Import a beancount file that posts to these non-postable accounts
    const beancount = `
option "operating_currency" "USD"

2024-01-15 open Assets:Bank USD
2024-01-15 open Expenses:Food USD

2024-02-01 * "Grocery shopping"
  Expenses:Food  50.00 USD
  Assets:Bank   -50.00 USD
`;

    const result = await importLedger(backend, beancount, "beancount");
    expect(result.warnings).toEqual([]);
    expect(result.transactions_imported).toBe(1);

    // Verify the accounts are now postable
    const accounts = await backend.listAccounts();
    const bank = accounts.find((a) => a.full_name === "Assets:Bank");
    const food = accounts.find((a) => a.full_name === "Expenses:Food");
    expect(bank?.is_postable).toBe(true);
    expect(food?.is_postable).toBe(true);
  });

  it("should make non-postable accounts postable during ledger import", async () => {
    const backend = await createTestBackend();
    const { v7: uuidv7 } = await import("uuid");

    await backend.createCurrency({
      code: "USD", asset_type: "",
      name: "US Dollar", decimal_places: 2,
    });

    const assetsId = uuidv7();
    await backend.createAccount({
      id: assetsId, parent_id: null, account_type: "asset",
      name: "Assets", full_name: "Assets",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const bankId = uuidv7();
    await backend.createAccount({
      id: bankId, parent_id: assetsId, account_type: "asset",
      name: "Bank", full_name: "Assets:Bank",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const expensesId = uuidv7();
    await backend.createAccount({
      id: expensesId, parent_id: null, account_type: "expense",
      name: "Expenses", full_name: "Expenses",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    const foodId = uuidv7();
    await backend.createAccount({
      id: foodId, parent_id: expensesId, account_type: "expense",
      name: "Food", full_name: "Expenses:Food",
      allowed_currencies: [], is_postable: false, is_archived: false,
      created_at: "2024-01-01",
    });

    // Import a ledger file that posts to these non-postable accounts
    const ledger = `
commodity USD

2024-02-01 * Grocery shopping
    Expenses:Food  50.00 USD
    Assets:Bank   -50.00 USD
`;

    const result = await importLedger(backend, ledger, "ledger");
    expect(result.warnings).toEqual([]);
    expect(result.transactions_imported).toBe(1);

    const accounts = await backend.listAccounts();
    const bank = accounts.find((a) => a.full_name === "Assets:Bank");
    const food = accounts.find((a) => a.full_name === "Expenses:Food");
    expect(bank?.is_postable).toBe(true);
    expect(food?.is_postable).toBe(true);
  });
});
