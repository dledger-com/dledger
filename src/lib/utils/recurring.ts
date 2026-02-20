import { v7 as uuidv7 } from "uuid";
import type { Backend, RecurringTemplate } from "$lib/backend.js";
import type { JournalEntry, LineItem } from "$lib/types/index.js";

/**
 * Advance a date by the given frequency and interval.
 */
export function advanceDate(
  date: string,
  frequency: RecurringTemplate["frequency"],
  interval: number,
): string {
  // Parse as UTC to avoid timezone shifts
  const [y, m, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, day));
  switch (frequency) {
    case "daily":
      d.setUTCDate(d.getUTCDate() + interval);
      break;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + interval * 7);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + interval);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() + interval);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Count how many templates have entries due (next_date <= asOfDate).
 */
export async function countDueTemplates(
  backend: Backend,
  asOfDate?: string,
): Promise<number> {
  const date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const templates = await backend.listRecurringTemplates();
  return templates.filter((t) => t.is_active && t.next_date <= date).length;
}

/**
 * Generate journal entries for all due recurring templates.
 * Returns the number of entries created.
 */
export async function generateDueEntries(
  backend: Backend,
  asOfDate?: string,
): Promise<number> {
  const date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const templates = await backend.listRecurringTemplates();
  let count = 0;

  for (const template of templates) {
    if (!template.is_active) continue;

    // Generate entries for each due date
    let nextDate = template.next_date;
    let deactivated = false;
    while (nextDate <= date) {
      // Check end_date
      if (template.end_date && nextDate > template.end_date) {
        // Deactivate template
        await backend.updateRecurringTemplate({ ...template, is_active: false, next_date: nextDate });
        deactivated = true;
        break;
      }

      const entryId = uuidv7();
      const entry: JournalEntry = {
        id: entryId,
        date: nextDate,
        description: template.description,
        status: "confirmed",
        source: `recurring:${template.id}`,
        voided_by: null,
        created_at: new Date().toISOString(),
      };
      const items: LineItem[] = template.line_items.map((li) => ({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: li.account_id,
        currency: li.currency,
        amount: li.amount,
        lot_id: null,
      }));

      await backend.postJournalEntry(entry, items);
      await backend.setMetadata(entryId, { recurring_template_id: template.id });
      count++;

      nextDate = advanceDate(nextDate, template.frequency, template.interval);
    }

    // Update template's next_date (unless already deactivated)
    if (!deactivated && nextDate !== template.next_date) {
      await backend.updateRecurringTemplate({ ...template, next_date: nextDate });
    }
  }

  return count;
}

/**
 * Create a recurring template from an existing journal entry.
 */
export function templateFromEntry(
  entry: JournalEntry,
  items: LineItem[],
  frequency: RecurringTemplate["frequency"] = "monthly",
  interval: number = 1,
): RecurringTemplate {
  return {
    id: uuidv7(),
    description: entry.description,
    frequency,
    interval,
    next_date: advanceDate(entry.date, frequency, interval),
    end_date: null,
    is_active: true,
    line_items: items.map((i) => ({
      account_id: i.account_id,
      currency: i.currency,
      amount: i.amount,
    })),
    created_at: new Date().toISOString(),
  };
}
