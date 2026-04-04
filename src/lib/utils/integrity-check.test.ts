import { describe, it, expect } from "vitest";
import { seedBasicLedger } from "../../test/helpers.js";
import { runIntegrityChecks } from "./integrity-check.js";
import { v7 as uuidv7 } from "uuid";

// Helper to run raw SQL on the private db, bypassing validation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawRun(backend: any, sql: string, params: unknown[] = []): void {
  backend.run(sql, params);
}

describe("runIntegrityChecks", () => {
  it("passes on a clean seeded ledger", async () => {
    const { backend } = await seedBasicLedger();
    const issues = await runIntegrityChecks(backend);
    const trialIssues = issues.filter((i) => i.category === "Trial Balance");
    expect(trialIssues).toHaveLength(0);
  });

  it("tolerates sub-precision floating-point residual", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Create a currency with 8 decimal places (like tBTC)
    await backend.createCurrency({
      code: "tBTC",
      asset_type: "",
      name: "tBTC",
      decimal_places: 8,
    });

    // Insert a journal entry via raw SQL that has a tiny residual (2.5e-17)
    // which is far below 10^-8 = 0.00000001 tolerance
    const entryId = uuidv7();
    const li1Id = uuidv7();
    const li2Id = uuidv7();
    rawRun(backend,
      "INSERT INTO journal_entry (id, date, description, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [entryId, "2024-02-01", "DeFi residual", "confirmed", "etherscan", "2024-02-01"],
    );
    // Debit side: 1 + tiny FP artefact
    rawRun(backend,
      "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount) VALUES (?, ?, ?, ?, ?)",
      [li1Id, entryId, accounts.bank.id, "tBTC", "1.000000000000000025"],
    );
    // Credit side: -1
    rawRun(backend,
      "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount) VALUES (?, ?, ?, ?, ?)",
      [li2Id, entryId, accounts.salary.id, "tBTC", "-1"],
    );

    const issues = await runIntegrityChecks(backend);
    const tbtcIssue = issues.find(
      (i) => i.category === "Trial Balance" && i.message.includes("tBTC"),
    );
    expect(tbtcIssue).toBeUndefined();
  });

  it("catches a real imbalance exceeding tolerance", async () => {
    const { backend, accounts } = await seedBasicLedger();

    // Insert an imbalanced entry via raw SQL — extra $5 debit with no offsetting credit
    const entryId = uuidv7();
    const liId = uuidv7();
    rawRun(backend,
      "INSERT INTO journal_entry (id, date, description, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [entryId, "2024-02-01", "Broken entry", "confirmed", "manual", "2024-02-01"],
    );
    rawRun(backend,
      "INSERT INTO line_item (id, journal_entry_id, account_id, currency, amount) VALUES (?, ?, ?, ?, ?)",
      [liId, entryId, accounts.bank.id, "USD", "5"],
    );

    const issues = await runIntegrityChecks(backend);
    const usdIssue = issues.find(
      (i) => i.category === "Trial Balance" && i.message.includes("USD"),
    );
    expect(usdIssue).toBeDefined();
    expect(usdIssue!.severity).toBe("error");
    expect(usdIssue!.message).toContain("does not balance");
  });
});
