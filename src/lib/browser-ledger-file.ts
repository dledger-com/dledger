import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "./backend.js";
import type {
  Account,
  AccountType,
  JournalEntry,
  JournalEntryStatus,
  LineItem,
  ExchangeRate,
  LedgerImportResult,
} from "./types/index.js";

// ---- Helpers ----

function tryParseDatePrefix(s: string): string | null {
  if (s.length < 10) return null;
  const candidate = s.substring(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  return null;
}

function inferAccountType(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "Assets":
    case "Asset":
      return "asset";
    case "Liabilities":
    case "Liability":
      return "liability";
    case "Equity":
    case "Exchange":
      return "equity";
    case "Income":
    case "Revenue":
      return "revenue";
    case "Expenses":
    case "Expense":
      return "expense";
    default:
      throw new Error(`cannot infer account type from '${fullName}'`);
  }
}

function splitAccountAmount(line: string): [string, string] {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\t") {
      return [line.substring(0, i).trim(), line.substring(i).trim()];
    }
    if (i + 1 < line.length && line[i] === " " && line[i + 1] === " ") {
      return [line.substring(0, i).trim(), line.substring(i).trim()];
    }
  }
  return [line.trim(), ""];
}

// ---- Import ----

export async function importLedger(
  backend: Backend,
  content: string,
): Promise<LedgerImportResult> {
  const result: LedgerImportResult = {
    accounts_created: 0,
    currencies_created: 0,
    transactions_imported: 0,
    prices_imported: 0,
    warnings: [],
    transaction_currency_dates: [],
  };

  const currencyDateSet = new Set<string>();

  // Build local caches
  const existingCurrencies = new Set(
    (await backend.listCurrencies()).map((c) => c.code),
  );
  const existingAccounts = new Map<string, Account>();
  for (const acc of await backend.listAccounts()) {
    existingAccounts.set(acc.full_name, acc);
  }

  async function ensureCurrency(code: string): Promise<void> {
    if (existingCurrencies.has(code)) return;
    await backend.createCurrency({
      code,
      name: code,
      decimal_places: code.length <= 3 ? 2 : 8,
      is_base: false,
    });
    existingCurrencies.add(code);
    result.currencies_created++;
  }

  async function ensureAccount(
    fullName: string,
    allowedCurrencies: string[],
    date: string,
  ): Promise<string> {
    const existing = existingAccounts.get(fullName);
    if (existing) return existing.id;

    const accountType = inferAccountType(fullName);
    const parts = fullName.split(":");
    let parentId: string | null = null;

    for (let depth = 1; depth < parts.length; depth++) {
      const ancestorName = parts.slice(0, depth).join(":");
      const existingAncestor = existingAccounts.get(ancestorName);
      if (existingAncestor) {
        parentId = existingAncestor.id;
      } else {
        const id = uuidv7();
        const acc: Account = {
          id,
          parent_id: parentId,
          account_type: accountType,
          name: parts[depth - 1],
          full_name: ancestorName,
          allowed_currencies: [],
          is_postable: true,
          is_archived: false,
          created_at: date,
        };
        await backend.createAccount(acc);
        existingAccounts.set(ancestorName, acc);
        result.accounts_created++;
        parentId = id;
      }
    }

    const id = uuidv7();
    const acc: Account = {
      id,
      parent_id: parentId,
      account_type: accountType,
      name: parts[parts.length - 1],
      full_name: fullName,
      allowed_currencies: allowedCurrencies,
      is_postable: true,
      is_archived: false,
      created_at: date,
    };
    await backend.createAccount(acc);
    existingAccounts.set(fullName, acc);
    result.accounts_created++;
    return id;
  }

  // ---- Directive parsers ----

  async function parsePriceDirective(
    line: string,
    lineNum: number,
  ): Promise<void> {
    const tokens = line.split(/\s+/);
    if (tokens.length < 5)
      throw new Error(`line ${lineNum}: malformed price directive`);
    const date = tokens[1];
    const fromCommodity = tokens[2];
    const rate = tokens[3];
    const toCommodity = tokens[4];

    try {
      new Decimal(rate);
    } catch {
      throw new Error(`line ${lineNum}: bad rate '${rate}'`);
    }

    await ensureCurrency(fromCommodity);
    await ensureCurrency(toCommodity);

    const er: ExchangeRate = {
      id: uuidv7(),
      date,
      from_currency: fromCommodity,
      to_currency: toCommodity,
      rate,
      source: "ledger-file",
    };
    await backend.recordExchangeRate(er);
    result.prices_imported++;
  }

  async function parseOpenDirective(
    date: string,
    rest: string,
    lineNum: number,
  ): Promise<void> {
    const tokens = rest.split(/\s+/);
    if (tokens.length === 0)
      throw new Error(
        `line ${lineNum}: open directive missing account name`,
      );
    const accountName = tokens[0];
    const allowed = tokens.slice(1).map((s) => s.replace(/,$/, ""));

    for (const code of allowed) {
      await ensureCurrency(code);
    }

    await ensureAccount(accountName, allowed, date);
  }

  async function parseCloseDirective(
    rest: string,
    lineNum: number,
  ): Promise<void> {
    const accountName = rest.split(/\s+/)[0];
    if (!accountName)
      throw new Error(
        `line ${lineNum}: close directive missing account name`,
      );

    const acc = existingAccounts.get(accountName);
    if (acc) {
      await backend.archiveAccount(acc.id);
    } else {
      result.warnings.push(
        `line ${lineNum}: close directive for unknown account '${accountName}'`,
      );
    }
  }

  async function parseBalanceDirective(
    date: string,
    rest: string,
    lineNum: number,
  ): Promise<void> {
    const tokens = rest.split(/\s+/);
    if (tokens.length < 3)
      throw new Error(
        `line ${lineNum}: balance directive needs ACCOUNT AMOUNT COMMODITY`,
      );
    const accountName = tokens[0];
    const amountStr = tokens[1];
    const commodity = tokens[2];

    try {
      new Decimal(amountStr);
    } catch {
      throw new Error(`line ${lineNum}: bad amount '${amountStr}'`);
    }

    await ensureCurrency(commodity);
    await ensureAccount(accountName, [], date);

    const acc = existingAccounts.get(accountName)!;
    const balances = await backend.getAccountBalance(acc.id, date);
    const actual = balances.find((b) => b.currency === commodity);
    const actualAmount = actual ? new Decimal(actual.amount) : new Decimal(0);
    const expected = new Decimal(amountStr);

    if (!actualAmount.eq(expected)) {
      result.warnings.push(
        `line ${lineNum}: balance assertion failed for ${accountName} ${commodity} ${date} (expected ${amountStr}, actual ${actualAmount.toString()})`,
      );
    }
  }

  // ---- Posting parser ----

  interface ParsedPosting {
    accountName: string;
    amount?: string;
    commodity?: string;
    costPrice?: { price: string; commodity: string };
  }

  function parsePostingLine(
    line: string,
    lineNum: number,
  ): ParsedPosting | null {
    const [account, rest] = splitAccountAmount(line);

    if (!rest) {
      return { accountName: account };
    }

    const tokens = rest.split(/\s+/);
    if (tokens.length === 0) {
      return { accountName: account };
    }

    if (tokens.length >= 2 && tokens[0] === "BOOK") {
      result.warnings.push(
        `line ${lineNum}: BOOK ${tokens[1]} posting skipped`,
      );
      return null;
    }

    try {
      new Decimal(tokens[0]);
    } catch {
      throw new Error(`line ${lineNum}: bad amount '${tokens[0]}'`);
    }

    if (tokens.length < 2) {
      throw new Error(
        `line ${lineNum}: posting has amount but no commodity`,
      );
    }

    const commodity = tokens[1];
    let costPrice: { price: string; commodity: string } | undefined;
    if (tokens.length >= 5 && tokens[2] === "@") {
      try {
        new Decimal(tokens[3]);
      } catch {
        throw new Error(
          `line ${lineNum}: bad cost price '${tokens[3]}'`,
        );
      }
      costPrice = { price: tokens[3], commodity: tokens[4] };
    }

    return { accountName: account, amount: tokens[0], commodity, costPrice };
  }

  // ---- Transaction parser ----

  async function parseTransaction(
    date: string,
    headerRest: string,
    allLines: string[],
    startIdx: number,
  ): Promise<number> {
    let rest = headerRest;
    let status: JournalEntryStatus = "confirmed";

    if (rest.startsWith("* ") || rest.startsWith("*\t")) {
      rest = rest.substring(2).trimStart();
      status = "confirmed";
    } else if (rest.startsWith("! ") || rest.startsWith("!\t")) {
      rest = rest.substring(2).trimStart();
      status = "pending";
    }

    // Handle (CODE)
    if (rest.startsWith("(")) {
      const end = rest.indexOf(")");
      if (end !== -1) {
        const code = rest.substring(1, end);
        const after = rest.substring(end + 1).trimStart();
        if (after) {
          rest = `(${code}) ${after}`;
        }
      }
    }

    const description = rest;

    // Collect posting lines
    const postings: ParsedPosting[] = [];
    let ii = startIdx + 1;

    while (ii < allLines.length) {
      const line = allLines[ii];
      if (!line.startsWith(" ") && !line.startsWith("\t")) break;
      const trimmedLine = line.trim();
      if (!trimmedLine) break;
      if (trimmedLine.startsWith(";") || trimmedLine.startsWith("#")) {
        ii++;
        continue;
      }
      if (trimmedLine.startsWith("tags ")) {
        ii++;
        continue;
      }

      const commentIdx = trimmedLine.indexOf(";");
      const withoutComment =
        commentIdx !== -1
          ? trimmedLine.substring(0, commentIdx).trim()
          : trimmedLine;
      if (!withoutComment) {
        ii++;
        continue;
      }

      const posting = parsePostingLine(withoutComment, ii + 1);
      if (posting) postings.push(posting);
      ii++;
    }

    const consumed = ii - startIdx;

    if (postings.length === 0) {
      result.warnings.push(
        `line ${startIdx + 1}: transaction '${description}' has no postings, skipped`,
      );
      return consumed;
    }

    // Handle elided amounts
    const elidedCount = postings.filter(
      (p) => p.amount === undefined,
    ).length;
    if (elidedCount > 1) {
      throw new Error(
        `line ${startIdx + 1}: transaction has ${elidedCount} postings with elided amounts (max 1)`,
      );
    }

    if (elidedCount === 1) {
      const sums = new Map<string, Decimal>();
      for (const p of postings) {
        if (p.amount === undefined) continue;
        if (p.costPrice) {
          const costTotal = new Decimal(p.amount).times(
            new Decimal(p.costPrice.price),
          );
          const cur =
            sums.get(p.costPrice.commodity) ?? new Decimal(0);
          sums.set(p.costPrice.commodity, cur.plus(costTotal));
        } else {
          const cur = sums.get(p.commodity!) ?? new Decimal(0);
          sums.set(p.commodity!, cur.plus(new Decimal(p.amount)));
        }
      }

      const unbalanced: [string, Decimal][] = [];
      for (const [currency, sum] of sums) {
        if (!sum.isZero()) unbalanced.push([currency, sum]);
      }

      if (unbalanced.length === 0) {
        throw new Error(
          `line ${startIdx + 1}: cannot auto-balance: all currencies already balance`,
        );
      } else if (unbalanced.length === 1) {
        const [commodity, sum] = unbalanced[0];
        const elided = postings.find(
          (p) => p.amount === undefined,
        )!;
        elided.amount = sum.neg().toString();
        elided.commodity = commodity;
      } else {
        const elidedIdx = postings.findIndex(
          (p) => p.amount === undefined,
        );
        const elidedAccount = postings[elidedIdx].accountName;
        postings.splice(elidedIdx, 1);
        for (const [commodity, sum] of unbalanced) {
          postings.push({
            accountName: elidedAccount,
            amount: sum.neg().toString(),
            commodity,
          });
        }
      }
    }

    // Build journal entry and line items
    const entryId = uuidv7();
    const items: LineItem[] = [];

    for (const p of postings) {
      const amount = p.amount!;
      const commodity = p.commodity!;

      await ensureCurrency(commodity);
      const accountId = await ensureAccount(
        p.accountName,
        [],
        date,
      );

      items.push({
        id: uuidv7(),
        journal_entry_id: entryId,
        account_id: accountId,
        currency: commodity,
        amount,
        lot_id: null,
      });

      if (p.costPrice) {
        await ensureCurrency(p.costPrice.commodity);
        const tradingAccountName = `Equity:Trading:${commodity}`;
        const tradingId = await ensureAccount(
          tradingAccountName,
          [],
          date,
        );

        // Balance the primary commodity
        items.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: tradingId,
          currency: commodity,
          amount: new Decimal(amount).neg().toString(),
          lot_id: null,
        });

        // Add cost total in cost commodity
        const costTotal = new Decimal(amount).times(
          new Decimal(p.costPrice.price),
        );
        items.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: tradingId,
          currency: p.costPrice.commodity,
          amount: costTotal.toString(),
          lot_id: null,
        });

        // Record implied exchange rate from cost syntax
        await backend.recordExchangeRate({
          id: uuidv7(),
          date,
          from_currency: commodity,
          to_currency: p.costPrice.commodity,
          rate: p.costPrice.price,
          source: "transaction",
        });
      }
    }

    const entry: JournalEntry = {
      id: entryId,
      date,
      description,
      status,
      source: "ledger-file",
      voided_by: null,
      created_at: date,
    };

    try {
      await backend.postJournalEntry(entry, items);
      result.transactions_imported++;

      // Collect unique (currency, date) pairs for historical rate backfill
      for (const item of items) {
        const key = `${item.currency}:${date}`;
        if (!currencyDateSet.has(key)) {
          currencyDateSet.add(key);
          result.transaction_currency_dates!.push([item.currency, date]);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`line ${startIdx + 1}: ${msg}`);
    }

    return consumed;
  }

  // ---- Main parse loop ----

  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (
      !trimmed ||
      trimmed.startsWith(";") ||
      trimmed.startsWith("#")
    ) {
      i++;
      continue;
    }

    if (
      trimmed.startsWith("pushtag") ||
      trimmed.startsWith("poptag")
    ) {
      i++;
      continue;
    }

    if (trimmed.startsWith("P ")) {
      await parsePriceDirective(trimmed, i + 1);
      i++;
      continue;
    }

    const date = tryParseDatePrefix(trimmed);
    if (date) {
      const rest = trimmed.substring(10).trim();

      if (rest.startsWith("open ")) {
        await parseOpenDirective(
          date,
          rest.substring(5).trim(),
          i + 1,
        );
        i++;
        continue;
      }

      if (rest.startsWith("close ")) {
        await parseCloseDirective(rest.substring(6).trim(), i + 1);
        i++;
        continue;
      }

      if (rest.startsWith("balance")) {
        const balRest = rest.substring(7).trim();
        await parseBalanceDirective(date, balRest, i + 1);
        i++;
        continue;
      }

      if (rest.startsWith("pad ")) {
        result.warnings.push(
          `line ${i + 1}: pad directive skipped`,
        );
        i++;
        continue;
      }

      // Transaction block
      const consumed = await parseTransaction(
        date,
        rest,
        lines,
        i,
      );
      i += consumed;
      continue;
    }

    i++;
  }

  return result;
}

// ---- Export ----

export async function exportLedger(backend: Backend): Promise<string> {
  let out = "; Generated by dLedger\n\n";

  const accounts = await backend.listAccounts();
  const sorted = [...accounts].sort((a, b) => {
    const dateCompare = a.created_at.localeCompare(b.created_at);
    return dateCompare !== 0
      ? dateCompare
      : a.full_name.localeCompare(b.full_name);
  });

  for (const acc of sorted) {
    const commodities =
      acc.allowed_currencies.length > 0
        ? `  ${acc.allowed_currencies.join(",")}`
        : "";
    out += `${acc.created_at} open ${acc.full_name}${commodities}\n`;
    // Emit account metadata as comments
    try {
      const meta = await backend.getAccountMetadata(acc.id);
      for (const [key, value] of Object.entries(meta)) {
        out += `  ; ${key}: ${value}\n`;
      }
    } catch {
      // Account metadata is optional, skip on error
    }
  }
  out += "\n";

  const entries = await backend.queryJournalEntries({});
  const sortedEntries = [...entries].sort((a, b) =>
    a[0].date.localeCompare(b[0].date),
  );

  for (const [entry, items] of sortedEntries) {
    if (entry.status === "voided") continue;
    const statusMarker = entry.status === "confirmed" ? " *" : " !";
    out += `${entry.date}${statusMarker} ${entry.description}\n`;
    for (const item of items) {
      const accName =
        accounts.find((a) => a.id === item.account_id)?.full_name ??
        "Unknown";
      out += `  ${accName}  ${item.amount} ${item.currency}\n`;
    }
    out += "\n";
  }

  const rates = await backend.listExchangeRates();
  const sortedRates = [...rates].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  for (const rate of sortedRates) {
    out += `P ${rate.date} ${rate.from_currency} ${rate.rate} ${rate.to_currency}\n`;
  }

  return out;
}
