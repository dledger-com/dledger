import { describe, it, expect } from "vitest";
import { createTestBackend, seedBasicLedger, makeEntry, makeLineItem } from "../../test/helpers.js";
import { computeReconciledBalance, isDifferenceZero, computeDifference } from "./reconciliation.js";
import type { UnreconciledLineItem } from "$lib/backend.js";
import { v7 as uuidv7 } from "uuid";

function makeUnreconciled(
  amount: string,
  overrides: Partial<UnreconciledLineItem> = {},
): UnreconciledLineItem {
  return {
    line_item_id: uuidv7(),
    entry_id: uuidv7(),
    entry_date: "2024-01-15",
    entry_description: "Test",
    account_id: "acc-1",
    currency: "USD",
    amount,
    is_reconciled: false,
    ...overrides,
  };
}

describe("reconciliation utilities", () => {
  it("computeReconciledBalance sums selected items", () => {
    const items = [
      makeUnreconciled("100"),
      makeUnreconciled("-50"),
      makeUnreconciled("200"),
    ];
    const selected = new Set([items[0].line_item_id, items[1].line_item_id]);
    expect(computeReconciledBalance(items, selected)).toBe("50");
  });

  it("computeReconciledBalance returns 0 for empty selection", () => {
    const items = [makeUnreconciled("100")];
    expect(computeReconciledBalance(items, new Set())).toBe("0");
  });

  it("isDifferenceZero with matching selection", () => {
    const items = [makeUnreconciled("1000"), makeUnreconciled("-50")];
    const allIds = new Set(items.map((i) => i.line_item_id));
    expect(isDifferenceZero("950", items, allIds)).toBe(true);
  });

  it("isDifferenceZero with existing reconciled balance", () => {
    const items = [makeUnreconciled("200")];
    const allIds = new Set(items.map((i) => i.line_item_id));
    expect(isDifferenceZero("1200", items, allIds, "1000")).toBe(true);
  });

  it("computeDifference returns correct value", () => {
    const items = [makeUnreconciled("500")];
    const allIds = new Set(items.map((i) => i.line_item_id));
    expect(computeDifference("1000", items, allIds)).toBe("500");
  });
});

describe("reconciliation backend integration", () => {
  it("getUnreconciledLineItems returns items", async () => {
    const { backend, accounts } = await seedBasicLedger();
    const items = await backend.getUnreconciledLineItems(accounts.bank.id, "USD");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !i.is_reconciled)).toBe(true);
  });

  it("markReconciled marks items and creates reconciliation", async () => {
    const { backend, accounts } = await seedBasicLedger();

    const items = await backend.getUnreconciledLineItems(accounts.bank.id, "USD");
    expect(items.length).toBeGreaterThan(0);

    const lineItemIds = items.map((i) => i.line_item_id);
    const recId = uuidv7();
    await backend.markReconciled(
      {
        id: recId,
        account_id: accounts.bank.id,
        statement_date: "2024-01-31",
        statement_balance: "3950",
        currency: "USD",
        reconciled_at: "2024-02-01",
        line_item_count: lineItemIds.length,
      },
      lineItemIds,
    );

    // Items should now be reconciled
    const afterItems = await backend.getUnreconciledLineItems(accounts.bank.id, "USD");
    expect(afterItems.length).toBe(0);

    // Reconciliation should be listed
    const recs = await backend.listReconciliations(accounts.bank.id);
    expect(recs.length).toBe(1);
    expect(recs[0].statement_balance).toBe("3950");

    // Detail should include line item IDs
    const detail = await backend.getReconciliationDetail(recId);
    expect(detail).not.toBeNull();
    expect(detail!.lineItemIds.length).toBe(lineItemIds.length);
  });
});
