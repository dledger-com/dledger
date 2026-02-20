import { describe, it, expect, beforeEach } from "vitest";
import { createTestBackend, seedBasicLedger, type SeededLedger } from "../../test/helpers.js";
import type { SqlJsBackend } from "$lib/sql-js-backend.js";

describe("countJournalEntries", () => {
  let seed: SeededLedger;

  beforeEach(async () => {
    seed = await seedBasicLedger();
  });

  it("counts all entries", async () => {
    // seedBasicLedger creates 3 entries
    const count = await seed.backend.countJournalEntries({});
    expect(count).toBe(3);
  });

  it("counts entries with date range filter", async () => {
    const count = await seed.backend.countJournalEntries({
      from_date: "2024-01-10",
      to_date: "2024-01-20",
    });
    // Only entries on 2024-01-15 and 2024-01-20
    expect(count).toBe(2);
  });

  it("counts entries with account filter", async () => {
    const count = await seed.backend.countJournalEntries({
      account_id: seed.accounts.food.id,
    });
    // Only the grocery entry touches the food account
    expect(count).toBe(1);
  });

  it("counts entries with status filter", async () => {
    const count = await seed.backend.countJournalEntries({
      status: "confirmed",
    });
    expect(count).toBe(3);

    const pending = await seed.backend.countJournalEntries({
      status: "pending",
    });
    expect(pending).toBe(0);
  });

  it("counts entries with source filter", async () => {
    const count = await seed.backend.countJournalEntries({
      source: "manual",
    });
    expect(count).toBe(3);

    const other = await seed.backend.countJournalEntries({
      source: "csv-import",
    });
    expect(other).toBe(0);
  });

  it("returns 0 for empty database", async () => {
    const emptyBackend = await createTestBackend();
    const count = await emptyBackend.countJournalEntries({});
    expect(count).toBe(0);
  });
});
