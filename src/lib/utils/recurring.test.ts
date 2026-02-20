import { describe, it, expect } from "vitest";
import { createTestBackend, seedBasicLedger } from "../../test/helpers.js";
import { advanceDate, countDueTemplates, generateDueEntries, templateFromEntry } from "./recurring.js";
import type { RecurringTemplate } from "$lib/backend.js";
import { v7 as uuidv7 } from "uuid";

function makeTemplate(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: uuidv7(),
    description: "Monthly rent",
    frequency: "monthly",
    interval: 1,
    next_date: "2024-02-01",
    end_date: null,
    is_active: true,
    line_items: [
      { account_id: "Expenses:Rent", currency: "USD", amount: "1500" },
      { account_id: "Assets:Bank:Checking", currency: "USD", amount: "-1500" },
    ],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("advanceDate", () => {
  it("advances by days", () => {
    expect(advanceDate("2024-01-15", "daily", 1)).toBe("2024-01-16");
    expect(advanceDate("2024-01-31", "daily", 3)).toBe("2024-02-03");
  });

  it("advances by weeks", () => {
    expect(advanceDate("2024-01-01", "weekly", 1)).toBe("2024-01-08");
    expect(advanceDate("2024-01-01", "weekly", 2)).toBe("2024-01-15");
  });

  it("advances by months", () => {
    expect(advanceDate("2024-01-15", "monthly", 1)).toBe("2024-02-15");
    expect(advanceDate("2024-01-31", "monthly", 1)).toBe("2024-03-02"); // JS Date month overflow
    expect(advanceDate("2024-11-15", "monthly", 2)).toBe("2025-01-15");
  });

  it("advances by years", () => {
    expect(advanceDate("2024-03-15", "yearly", 1)).toBe("2025-03-15");
    expect(advanceDate("2024-02-29", "yearly", 1)).toBe("2025-03-01"); // Leap year edge
  });
});

describe("countDueTemplates", () => {
  it("counts active templates with next_date <= asOf", async () => {
    const backend = await createTestBackend();
    const t1 = makeTemplate({ next_date: "2024-01-15" });
    const t2 = makeTemplate({ next_date: "2024-03-01" });
    const t3 = makeTemplate({ next_date: "2024-01-10", is_active: false });
    await backend.createRecurringTemplate(t1);
    await backend.createRecurringTemplate(t2);
    await backend.createRecurringTemplate(t3);

    expect(await countDueTemplates(backend, "2024-02-01")).toBe(1);
    expect(await countDueTemplates(backend, "2024-03-15")).toBe(2);
  });
});

describe("generateDueEntries", () => {
  it("generates entries for due templates and advances next_date", async () => {
    const { backend, accounts } = await seedBasicLedger();
    const template = makeTemplate({
      next_date: "2024-01-15",
      line_items: [
        { account_id: accounts.bank.id, currency: "USD", amount: "-1500" },
        { account_id: accounts.food.id, currency: "USD", amount: "1500" },
      ],
    });
    await backend.createRecurringTemplate(template);

    const count = await generateDueEntries(backend, "2024-03-20");
    expect(count).toBe(3); // Jan 15, Feb 15, Mar 15

    const updated = await backend.listRecurringTemplates();
    expect(updated[0].next_date).toBe("2024-04-15");
  });

  it("deactivates template past end_date", async () => {
    const { backend, accounts } = await seedBasicLedger();
    const template = makeTemplate({
      next_date: "2024-01-01",
      end_date: "2024-02-15",
      line_items: [
        { account_id: accounts.bank.id, currency: "USD", amount: "-100" },
        { account_id: accounts.food.id, currency: "USD", amount: "100" },
      ],
    });
    await backend.createRecurringTemplate(template);

    const count = await generateDueEntries(backend, "2024-06-01");
    expect(count).toBe(2); // Jan 1, Feb 1 (Mar 1 > end_date)

    const updated = await backend.listRecurringTemplates();
    expect(updated[0].is_active).toBe(false);
  });

  it("skips inactive templates", async () => {
    const backend = await createTestBackend();
    const template = makeTemplate({ is_active: false, next_date: "2024-01-01" });
    await backend.createRecurringTemplate(template);

    const count = await generateDueEntries(backend, "2024-12-31");
    expect(count).toBe(0);
  });
});

describe("templateFromEntry", () => {
  it("creates template from entry", () => {
    const entry = {
      id: uuidv7(),
      date: "2024-01-15",
      description: "Salary",
      status: "confirmed" as const,
      source: "manual",
      voided_by: null,
      created_at: new Date().toISOString(),
    };
    const items = [
      { id: uuidv7(), journal_entry_id: entry.id, account_id: "Assets:Bank", currency: "USD", amount: "5000", lot_id: null },
      { id: uuidv7(), journal_entry_id: entry.id, account_id: "Income:Salary", currency: "USD", amount: "-5000", lot_id: null },
    ];
    const template = templateFromEntry(entry, items, "monthly", 1);
    expect(template.description).toBe("Salary");
    expect(template.frequency).toBe("monthly");
    expect(template.next_date).toBe("2024-02-15");
    expect(template.line_items).toHaveLength(2);
    expect(template.line_items[0].account_id).toBe("Assets:Bank");
    expect(template.is_active).toBe(true);
  });
});

describe("recurring template CRUD", () => {
  it("creates, lists, updates, and deletes templates", async () => {
    const backend = await createTestBackend();
    const template = makeTemplate();

    await backend.createRecurringTemplate(template);
    let templates = await backend.listRecurringTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].description).toBe("Monthly rent");
    expect(templates[0].line_items).toHaveLength(2);

    await backend.updateRecurringTemplate({ ...templates[0], description: "Updated rent" });
    templates = await backend.listRecurringTemplates();
    expect(templates[0].description).toBe("Updated rent");

    await backend.deleteRecurringTemplate(template.id);
    templates = await backend.listRecurringTemplates();
    expect(templates).toHaveLength(0);
  });
});
