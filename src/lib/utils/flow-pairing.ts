import type { LineItem } from "$lib/types/index.js";
import type { AccountType } from "$lib/types/account.js";

export type FlowType = "income" | "expense" | "transfer" | "equity" | "mixed";

export interface Flow {
  sourceAccountId: string; // credited account (money flows OUT)
  destAccountId: string; // debited account (money flows IN)
  amount: string; // absolute, always positive
  currency: string;
  flowType: FlowType;
}

export function classifyFlow(
  sourceType: AccountType | undefined,
  destType: AccountType | undefined,
): FlowType {
  if (!sourceType || !destType) return "mixed";

  if (sourceType === "equity" || destType === "equity") return "equity";
  if (sourceType === "revenue" && destType === "asset") return "income";
  if (sourceType === "asset" && destType === "expense") return "expense";
  if (
    (sourceType === "asset" && destType === "asset") ||
    (sourceType === "asset" && destType === "liability") ||
    (sourceType === "liability" && destType === "asset")
  )
    return "transfer";

  return "mixed";
}

export function pairLineItems(
  items: LineItem[],
  accountTypeLookup: (id: string) => AccountType | undefined,
): Flow[] {
  // Group by currency
  const byCurrency = new Map<string, { debits: LineItem[]; credits: LineItem[] }>();
  for (const item of items) {
    const amount = parseFloat(item.amount);
    if (amount === 0) continue;
    let group = byCurrency.get(item.currency);
    if (!group) {
      group = { debits: [], credits: [] };
      byCurrency.set(item.currency, group);
    }
    if (amount > 0) {
      group.debits.push(item);
    } else {
      group.credits.push(item);
    }
  }

  const flows: Flow[] = [];

  for (const [currency, { debits, credits }] of byCurrency) {
    // Work with mutable copies tracking remaining amounts
    const debitPool = debits.map((d) => ({
      item: d,
      remaining: parseFloat(d.amount),
    }));
    const creditPool = credits.map((c) => ({
      item: c,
      remaining: Math.abs(parseFloat(c.amount)),
    }));

    // Pass 1: Exact matches
    for (const d of debitPool) {
      if (d.remaining <= 0) continue;
      const matchIdx = creditPool.findIndex(
        (c) => c.remaining > 0 && Math.abs(c.remaining - d.remaining) < 1e-9,
      );
      if (matchIdx >= 0) {
        const c = creditPool[matchIdx];
        flows.push({
          sourceAccountId: c.item.account_id,
          destAccountId: d.item.account_id,
          amount: d.remaining.toString(),
          currency,
          flowType: classifyFlow(
            accountTypeLookup(c.item.account_id),
            accountTypeLookup(d.item.account_id),
          ),
        });
        d.remaining = 0;
        c.remaining = 0;
      }
    }

    // Pass 2: Proportional split for remaining
    const remainingDebits = debitPool.filter((d) => d.remaining > 1e-9);
    const remainingCredits = creditPool.filter((c) => c.remaining > 1e-9);

    for (const c of remainingCredits) {
      for (const d of remainingDebits) {
        if (c.remaining <= 1e-9 || d.remaining <= 1e-9) continue;
        const paired = Math.min(c.remaining, d.remaining);
        flows.push({
          sourceAccountId: c.item.account_id,
          destAccountId: d.item.account_id,
          amount: paired.toString(),
          currency,
          flowType: classifyFlow(
            accountTypeLookup(c.item.account_id),
            accountTypeLookup(d.item.account_id),
          ),
        });
        c.remaining -= paired;
        d.remaining -= paired;
      }
    }

    // Defensive: unpaired debits (no source)
    for (const d of debitPool) {
      if (d.remaining > 1e-9) {
        flows.push({
          sourceAccountId: "",
          destAccountId: d.item.account_id,
          amount: d.remaining.toString(),
          currency,
          flowType: "mixed",
        });
      }
    }

    // Defensive: unpaired credits (no dest)
    for (const c of creditPool) {
      if (c.remaining > 1e-9) {
        flows.push({
          sourceAccountId: c.item.account_id,
          destAccountId: "",
          amount: c.remaining.toString(),
          currency,
          flowType: "mixed",
        });
      }
    }
  }

  return flows;
}
