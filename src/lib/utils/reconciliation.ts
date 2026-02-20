import Decimal from "decimal.js-light";
import type { UnreconciledLineItem } from "$lib/backend.js";

/**
 * Compute the sum of selected line items' amounts.
 */
export function computeReconciledBalance(
  items: UnreconciledLineItem[],
  selectedIds: Set<string>,
): string {
  let total = new Decimal(0);
  for (const item of items) {
    if (selectedIds.has(item.line_item_id)) {
      total = total.plus(new Decimal(item.amount));
    }
  }
  return total.toString();
}

/**
 * Check if the difference between statement balance and selected items total is zero.
 */
export function isDifferenceZero(
  statementBalance: string,
  items: UnreconciledLineItem[],
  selectedIds: Set<string>,
  existingReconciledBalance: string = "0",
): boolean {
  const selected = new Decimal(computeReconciledBalance(items, selectedIds));
  const existing = new Decimal(existingReconciledBalance);
  const target = new Decimal(statementBalance);
  return selected.plus(existing).eq(target);
}

/**
 * Compute the difference: statement balance - (existing reconciled + selected items).
 */
export function computeDifference(
  statementBalance: string,
  items: UnreconciledLineItem[],
  selectedIds: Set<string>,
  existingReconciledBalance: string = "0",
): string {
  const selected = new Decimal(computeReconciledBalance(items, selectedIds));
  const existing = new Decimal(existingReconciledBalance);
  const target = new Decimal(statementBalance);
  return target.minus(selected.plus(existing)).toString();
}
