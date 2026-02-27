import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, AccountType } from "../types/index.js";

export type DefaultAccountSet = "minimal" | "standard" | "comprehensive";

export interface DefaultAccountDef {
  full_name: string;
  is_postable: boolean;
}

function d(full_name: string, is_postable = true): DefaultAccountDef {
  return { full_name, is_postable };
}

const MINIMAL: DefaultAccountDef[] = [
  d("Assets", false),
  d("Assets:Bank", false),
  d("Assets:Cash"),
  d("Assets:Investments", false),
  d("Assets:Receivable"),
  d("Liabilities", false),
  d("Liabilities:CreditCards", false),
  d("Liabilities:Loans", false),
  d("Equity", false),
  d("Equity:Opening"),
  d("Income", false),
  d("Income:Salary"),
  d("Income:Interest"),
  d("Income:Other"),
  d("Income:Uncategorized"),
  d("Expenses", false),
  d("Expenses:Groceries"),
  d("Expenses:Dining"),
  d("Expenses:Housing", false),
  d("Expenses:Housing:Rent"),
  d("Expenses:Utilities", false),
  d("Expenses:Utilities:Electric"),
  d("Expenses:Utilities:Internet"),
  d("Expenses:Transportation"),
  d("Expenses:Insurance", false),
  d("Expenses:Insurance:Health"),
  d("Expenses:Medical"),
  d("Expenses:Entertainment"),
  d("Expenses:Clothing"),
  d("Expenses:Miscellaneous"),
  d("Expenses:Uncategorized"),
];

const STANDARD_EXTRA: DefaultAccountDef[] = [
  d("Assets:Savings"),
  d("Liabilities:Mortgage"),
  d("Equity:Trading"),
  d("Equity:External"),
  d("Income:Bonus"),
  d("Income:Dividends"),
  d("Income:GiftsReceived"),
  d("Expenses:Housing:Maintenance"),
  d("Expenses:Utilities:Gas"),
  d("Expenses:Utilities:Water"),
  d("Expenses:Transportation:PublicTransit"),
  d("Expenses:Transportation:Fuel"),
  d("Expenses:Transportation:Parking"),
  d("Expenses:Auto", false),
  d("Expenses:Auto:Insurance"),
  d("Expenses:Auto:Repair"),
  d("Expenses:Auto:Fuel"),
  d("Expenses:Insurance:Life"),
  d("Expenses:Insurance:Home"),
  d("Expenses:Phone"),
  d("Expenses:Subscriptions"),
  d("Expenses:Education"),
  d("Expenses:Gifts"),
  d("Expenses:Charity"),
  d("Expenses:Taxes", false),
  d("Expenses:Taxes:Income"),
  d("Expenses:Travel"),
  d("Expenses:BankFees"),
];

const COMPREHENSIVE_EXTRA: DefaultAccountDef[] = [
  d("Assets:Receivable:Loans"),
  d("Liabilities:Loans:Auto"),
  d("Liabilities:Loans:Student"),
  d("Income:CapitalGains"),
  d("Income:Rental"),
  d("Expenses:Housing:Insurance"),
  d("Expenses:Utilities:Garbage"),
  d("Expenses:Auto:Parking"),
  d("Expenses:Auto:Registration"),
  d("Expenses:Insurance:Auto"),
  d("Expenses:Taxes:Property"),
  d("Expenses:Taxes:SocialSecurity"),
  d("Expenses:Entertainment:Movies"),
  d("Expenses:Entertainment:Recreation"),
  d("Expenses:Entertainment:Music"),
  d("Expenses:Hobbies"),
  d("Expenses:Books"),
  d("Expenses:Computer"),
  d("Expenses:Laundry"),
  d("Expenses:PersonalCare"),
  d("Expenses:Pets"),
  d("Expenses:HomeRepair"),
];

export const DEFAULT_ACCOUNTS: Record<DefaultAccountSet, DefaultAccountDef[]> = {
  minimal: MINIMAL,
  standard: [...MINIMAL, ...STANDARD_EXTRA],
  comprehensive: [...MINIMAL, ...STANDARD_EXTRA, ...COMPREHENSIVE_EXTRA],
};

function inferAccountType(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets":
      return "asset";
    case "Liabilities":
      return "liability";
    case "Equity":
      return "equity";
    case "Income":
      return "revenue";
    case "Expenses":
      return "expense";
    default:
      throw new Error(`cannot infer account type from '${fullName}'`);
  }
}

export async function createDefaultAccounts(
  backend: Backend,
  set: DefaultAccountSet,
): Promise<{ created: number; skipped: number }> {
  const accounts = await backend.listAccounts();
  const existingAccounts = new Map<string, Account>(accounts.map((a) => [a.full_name, a]));
  const today = new Date().toISOString().slice(0, 10);

  let created = 0;
  let skipped = 0;

  const defs = DEFAULT_ACCOUNTS[set];

  for (const def of defs) {
    if (existingAccounts.has(def.full_name)) {
      skipped++;
      continue;
    }

    // Ensure parent hierarchy exists
    const parts = def.full_name.split(":");
    const accountType = inferAccountType(def.full_name);
    let parentId: string | null = null;

    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorName = parts.slice(0, depth).join(":");
      const existing = existingAccounts.get(ancestorName);
      if (existing) {
        parentId = existing.id;
      } else {
        const id = uuidv7();
        const acc: Account = {
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: ancestorName,
          allowed_currencies: [],
          is_postable: false,
          is_archived: false,
          created_at: today,
        };
        await backend.createAccount(acc);
        existingAccounts.set(ancestorName, acc);
        created++;
      }
    }

    // Create the account itself
    const id = uuidv7();
    const acc: Account = {
      id,
      parent_id: parentId,
      account_type: accountType,
      name: parts[parts.length - 1],
      full_name: def.full_name,
      allowed_currencies: [],
      is_postable: def.is_postable,
      is_archived: false,
      created_at: today,
    };
    await backend.createAccount(acc);
    existingAccounts.set(def.full_name, acc);
    created++;
  }

  return { created, skipped };
}
