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
import { detectFormat, type LedgerFormat } from "./ledger-format.js";
import { tradingAccount } from "./accounts/paths.js";
import {
  computeEntryFingerprint,
  computeEntryAmountFingerprint,
} from "./csv-presets/dedup.js";

// ---- Helpers ----

/** Return the number of decimal places in a numeric string (e.g. "129.35" → 2). */
function decimalPlaces(s: string): number {
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Parse YYYY-MM-DD or YYYY/MM/DD date prefix, normalize to YYYY-MM-DD. */
function tryParseDatePrefix(s: string): string | null {
  if (s.length < 10) return null;
  const candidate = s.substring(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(candidate))
    return candidate.replace(/\//g, "-");
  return null;
}

function inferAccountType(fullName: string): AccountType {
  const first = fullName.split(":")[0];
  switch (first) {
    case "assets":
    case "Assets":
    case "Asset":
      return "asset";
    case "liabilities":
    case "Liabilities":
    case "Liability":
      return "liability";
    case "equity":
    case "Equity":
    case "Exchange":
      return "equity";
    case "income":
    case "Income":
    case "Revenue":
      return "revenue";
    case "expenses":
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
  // Fallback: single space before a number/sign (for beancount single-space postings)
  const m = line.match(/^(\S+)\s+([-+]?\d.*)$/);
  if (m) {
    return [m[1].trim(), m[2].trim()];
  }
  return [line.trim(), ""];
}

/** Strip thousands separators from a number string: "1,234.56" → "1234.56", "1.234,56" → "1234.56". */
function stripThousands(s: string): string {
  // European: "1.234,56" — dot thousands, comma decimal
  if (/\d\.\d{3},/.test(s)) {
    return s.replace(/\./g, "").replace(",", ".");
  }
  // Standard: "1,234.56" — comma thousands, dot decimal
  if (/\d,\d{3}/.test(s)) {
    return s.replace(/,/g, "");
  }
  return s;
}

/** Try to parse a string as a Decimal, stripping thousands separators if needed. */
function parseDecimal(s: string): Decimal {
  return new Decimal(stripThousands(s));
}

// ---- Import ----

export async function importLedger(
  backend: Backend,
  content: string,
  format?: LedgerFormat,
): Promise<LedgerImportResult> {
  const fmt = format ?? detectFormat(content);

  const result: LedgerImportResult = {
    accounts_created: 0,
    currencies_created: 0,
    transactions_imported: 0,
    prices_imported: 0,
    warnings: [],
    duplicates_skipped: 0,
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

  // Build dedup index from existing entries
  const fingerprints = new Set<string>();
  const amountFingerprints = new Set<string>();
  const existingEntries = await backend.queryJournalEntries({});
  for (const [entry, items] of existingEntries) {
    if (entry.voided_by !== null) continue;
    fingerprints.add(computeEntryFingerprint(entry, items));
    amountFingerprints.add(computeEntryAmountFingerprint(entry, items));
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
    // Normalize date: P YYYY/MM/DD → YYYY-MM-DD
    const date = tokens[1].replace(/\//g, "-");
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
    allLines: string[],
    lineIdx: number,
  ): Promise<number> {
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

    const accountId = await ensureAccount(accountName, allowed, date);

    // Parse beancount metadata lines after the directive
    if (fmt === "beancount") {
      const meta = collectBeancountMetadata(allLines, lineIdx + 1);
      if (Object.keys(meta.entries).length > 0) {
        await backend.setAccountMetadata(accountId, meta.entries);
      }
      return 1 + meta.linesConsumed;
    }

    return 1;
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

  // Deferred balance assertions — checked after all transactions are imported
  const deferredBalanceAssertions: {
    date: string;
    accountName: string;
    amountStr: string;
    commodity: string;
    lineNum: number;
  }[] = [];

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
    const amountStr = stripThousands(tokens[1]);
    const commodity = tokens[2];

    try {
      new Decimal(amountStr);
    } catch {
      throw new Error(`line ${lineNum}: bad amount '${amountStr}'`);
    }

    await ensureCurrency(commodity);
    await ensureAccount(accountName, [], date);

    deferredBalanceAssertions.push({ date, accountName, amountStr, commodity, lineNum });
  }

  // ---- Beancount metadata collector ----

  function collectBeancountMetadata(
    allLines: string[],
    startIdx: number,
  ): { entries: Record<string, string>; linesConsumed: number } {
    const entries: Record<string, string> = {};
    let consumed = 0;
    for (let j = startIdx; j < allLines.length; j++) {
      const raw = allLines[j];
      if (!raw.startsWith(" ") && !raw.startsWith("\t")) break;
      const trimmed = raw.trim();
      if (!trimmed) break;
      // Beancount metadata: key: value (key starts with lowercase letter)
      const m = trimmed.match(/^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/);
      if (m) {
        // Strip surrounding quotes from value
        let val = m[2].trim();
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        entries[m[1]] = val;
        consumed++;
      } else {
        break;
      }
    }
    return { entries, linesConsumed: consumed };
  }

  // ---- Posting parser ----

  interface ParsedPosting {
    accountName: string;
    amount?: string;
    commodity?: string;
    costPrice?: { price: string; commodity: string };
    lotCost?: { price: string; commodity: string } | { auto: true };
    balanceAssertion?: {
      amount: string;
      commodity: string;
      isStrict: boolean;
      includeSubaccounts: boolean;
    };
  }

  function parsePostingLine(
    line: string,
    lineNum: number,
  ): ParsedPosting | null {
    // hledger: skip virtual postings (Account) or [Account]
    if (fmt === "hledger") {
      const stripped = line.trim();
      if (stripped.startsWith("(") || stripped.startsWith("[")) {
        result.warnings.push(
          `line ${lineNum}: virtual posting skipped`,
        );
        return null;
      }
    }

    // Strip inline balance assertion before parsing (hledger: ` = AMOUNT COMMODITY`)
    let balanceAssertion: ParsedPosting["balanceAssertion"] | undefined;
    let lineForParsing = line;
    if (fmt === "hledger") {
      // Match =, ==, =*, ==* assertions
      const assertionMatch = line.match(
        /\s+(==?\*?)\s+(-?[\d,.]+)\s+(\S+)\s*$/,
      );
      if (assertionMatch) {
        lineForParsing = line.substring(
          0,
          line.length - assertionMatch[0].length,
        );
        const op = assertionMatch[1];
        balanceAssertion = {
          amount: stripThousands(assertionMatch[2]),
          commodity: assertionMatch[3],
          isStrict: op.startsWith("=="),
          includeSubaccounts: op.endsWith("*"),
        };
      }
    }

    // Strip beancount {cost} before splitting
    let lotCost: ParsedPosting["lotCost"] | undefined;
    if (fmt === "beancount") {
      const costMatch = lineForParsing.match(/\{([^}]*)\}/);
      if (costMatch) {
        lineForParsing = lineForParsing.replace(/\{[^}]*\}/, "").replace(/\s{2,}/g, "  ");
        const costInner = costMatch[1].trim();
        if (!costInner) {
          lotCost = { auto: true };
        } else {
          const costTokens = costInner.split(/\s+/);
          if (costTokens.length >= 2) {
            lotCost = {
              price: stripThousands(costTokens[0]),
              commodity: costTokens[1].replace(/,+$/, ""),
            };
          }
        }
      }
    }

    const [account, rest] = splitAccountAmount(lineForParsing);

    if (!rest) {
      return { accountName: account, balanceAssertion, lotCost };
    }

    const tokens = rest.split(/\s+/);
    if (tokens.length === 0) {
      return { accountName: account, balanceAssertion, lotCost };
    }

    if (tokens.length >= 2 && tokens[0] === "BOOK") {
      result.warnings.push(
        `line ${lineNum}: BOOK ${tokens[1]} posting skipped`,
      );
      return null;
    }

    let amount: string;
    let commodity: string;
    let costPrice: { price: string; commodity: string } | undefined;

    // hledger: prefix currency — detect $100.00, EUR 100.00, etc.
    if (fmt === "hledger" && tokens.length >= 1) {
      const prefixCurrencyMatch = tokens[0].match(/^([\$€£¥])(-?[\d,.]+)$/);
      if (prefixCurrencyMatch) {
        // Symbol-prefixed: $100.00
        commodity = prefixCurrencyMatch[1] === "$" ? "USD" :
                    prefixCurrencyMatch[1] === "€" ? "EUR" :
                    prefixCurrencyMatch[1] === "£" ? "GBP" :
                    prefixCurrencyMatch[1] === "¥" ? "JPY" : prefixCurrencyMatch[1];
        amount = stripThousands(prefixCurrencyMatch[2]);
        try {
          new Decimal(amount);
        } catch {
          throw new Error(`line ${lineNum}: bad amount '${amount}'`);
        }
        return { accountName: account, amount, commodity, costPrice, lotCost, balanceAssertion };
      }
      // Named prefix: EUR 100.00 (first token is non-numeric, uppercase)
      if (/^[A-Z]{2,}$/.test(tokens[0]) && tokens.length >= 2) {
        const testAmount = stripThousands(tokens[1]);
        try {
          new Decimal(testAmount);
          // It parsed as a number — this is prefix currency
          commodity = tokens[0];
          amount = testAmount;
          // Check for @ cost after prefix currency
          if (tokens.length >= 5 && tokens[2] === "@") {
            try {
              new Decimal(tokens[3]);
            } catch {
              throw new Error(`line ${lineNum}: bad cost price '${tokens[3]}'`);
            }
            costPrice = { price: tokens[3], commodity: tokens[4] };
          }
          return { accountName: account, amount, commodity, costPrice, lotCost, balanceAssertion };
        } catch {
          // Not a number — fall through to standard parsing
        }
      }
    }

    // Standard: AMOUNT COMMODITY
    try {
      amount = stripThousands(tokens[0]);
      new Decimal(amount);
    } catch {
      throw new Error(`line ${lineNum}: bad amount '${tokens[0]}'`);
    }

    if (tokens.length < 2) {
      if (defaultCommodity) {
        commodity = defaultCommodity;
      } else {
        throw new Error(
          `line ${lineNum}: posting has amount but no commodity`,
        );
      }
    } else {
      commodity = tokens[1];
      if (!defaultCommodity) {
        defaultCommodity = commodity;
      }
    }

    // Handle @@ (total cost) — beancount specific
    if (tokens.length >= 5 && tokens[2] === "@@") {
      try {
        const totalCost = stripThousands(tokens[3]);
        new Decimal(totalCost);
        const perUnit = new Decimal(totalCost)
          .div(new Decimal(amount).abs())
          .toString();
        costPrice = { price: perUnit, commodity: tokens[4] };
      } catch {
        throw new Error(
          `line ${lineNum}: bad total cost '${tokens[3]}'`,
        );
      }
    } else if (tokens.length >= 5 && tokens[2] === "@") {
      try {
        new Decimal(stripThousands(tokens[3]));
      } catch {
        throw new Error(
          `line ${lineNum}: bad cost price '${tokens[3]}'`,
        );
      }
      costPrice = { price: stripThousands(tokens[3]), commodity: tokens[4] };
    }

    return { accountName: account, amount, commodity, costPrice, lotCost, balanceAssertion };
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

    // Handle `txn` keyword (beancount)
    if (rest.startsWith("txn ") || rest.startsWith("txn\t") || rest === "txn") {
      rest = rest.substring(3).trimStart();
      status = "confirmed";
    } else if (rest.startsWith("* ") || rest.startsWith("*\t")) {
      rest = rest.substring(2).trimStart();
      status = "confirmed";
    } else if (rest.startsWith("! ") || rest.startsWith("!\t")) {
      rest = rest.substring(2).trimStart();
      status = "pending";
    }

    // Handle (CODE) — shared format
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

    // Beancount: strip tags (#tag) and links (^link) from the header line
    // (must happen before quote stripping since tags/links appear outside quotes)
    let tags = "";
    let links = "";
    if (fmt === "beancount") {
      const tagMatches = rest.match(/#[a-zA-Z0-9_-]+/g);
      const linkMatches = rest.match(/\^[a-zA-Z0-9_-]+/g);
      if (tagMatches) tags = tagMatches.join(" ");
      if (linkMatches) links = linkMatches.join(" ");
      rest = rest
        .replace(/#[a-zA-Z0-9_-]+/g, "")
        .replace(/\^[a-zA-Z0-9_-]+/g, "")
        .trim();
    }

    // Beancount: strip quoted description
    if (fmt === "beancount" && rest.startsWith('"')) {
      const endQuote = rest.indexOf('"', 1);
      if (endQuote !== -1) {
        rest = rest.substring(1, endQuote);
      }
    }

    // hledger: payee | narration → combine into description
    // (just use the combined string as-is, the | is part of the description)

    const description = rest;

    // Collect posting lines and beancount metadata
    const postings: ParsedPosting[] = [];
    const txnMetadata: Record<string, string> = {};
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

      // Beancount metadata: indented `key: value` before postings
      if (fmt === "beancount") {
        const metaMatch = trimmedLine.match(
          /^([a-z][a-z0-9_-]*)\s*:\s*(.+)$/,
        );
        if (metaMatch) {
          let val = metaMatch[2].trim();
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.slice(1, -1);
          }
          txnMetadata[metaMatch[1]] = val;
          ii++;
          continue;
        }
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
          const costTotal = new Decimal(p.amount)
            .times(new Decimal(p.costPrice.price))
            .toDecimalPlaces(decimalPlaces(p.costPrice.price));
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

    // Filter out zero-amount postings (valid in beancount/hledger but carry no accounting info)
    for (let pi = postings.length - 1; pi >= 0; pi--) {
      const pa = postings[pi].amount;
      if (pa !== undefined && new Decimal(pa).isZero()) {
        postings.splice(pi, 1);
      }
    }

    if (postings.length === 0) {
      result.warnings.push(
        `line ${startIdx + 1}: skipped transaction with only zero-amount postings`,
      );
      return consumed;
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

      // Handle {cost} lot syntax (beancount)
      if (p.lotCost && !("auto" in p.lotCost)) {
        await ensureCurrency(p.lotCost.commodity);
        const tradingAccountName = tradingAccount(commodity);
        const tradingId = await ensureAccount(
          tradingAccountName,
          [],
          date,
        );

        items.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: tradingId,
          currency: commodity,
          amount: new Decimal(amount).neg().toString(),
          lot_id: null,
        });

        const costTotal = new Decimal(amount)
          .times(new Decimal(p.lotCost.price))
          .toDecimalPlaces(decimalPlaces(p.lotCost.price));
        items.push({
          id: uuidv7(),
          journal_entry_id: entryId,
          account_id: tradingId,
          currency: p.lotCost.commodity,
          amount: costTotal.toString(),
          lot_id: null,
        });

        await backend.recordExchangeRate({
          id: uuidv7(),
          date,
          from_currency: commodity,
          to_currency: p.lotCost.commodity,
          rate: p.lotCost.price,
          source: "transaction",
        });
      } else if (p.costPrice) {
        await ensureCurrency(p.costPrice.commodity);
        const tradingAccountName = tradingAccount(commodity);
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
        const costTotal = new Decimal(amount)
          .times(new Decimal(p.costPrice.price))
          .toDecimalPlaces(decimalPlaces(p.costPrice.price));
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

      // Handle inline balance assertions (hledger)
      if (p.balanceAssertion) {
        const ba = p.balanceAssertion;
        await ensureCurrency(ba.commodity);
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

    // Dedup check — skip if fingerprint or amount fingerprint already exists
    const fp = computeEntryFingerprint(entry, items);
    const afp = computeEntryAmountFingerprint(entry, items);
    if (fingerprints.has(fp) || amountFingerprints.has(afp)) {
      result.duplicates_skipped++;
      return consumed;
    }

    try {
      await backend.postJournalEntry(entry, items);
      result.transactions_imported++;

      // Add to dedup sets for intra-batch dedup
      fingerprints.add(fp);
      amountFingerprints.add(afp);

      // Store beancount tags/links/metadata
      if (fmt === "beancount") {
        if (tags) txnMetadata["tags"] = tags;
        if (links) txnMetadata["links"] = links;
      }
      if (Object.keys(txnMetadata).length > 0) {
        await backend.setMetadata(entryId, txnMetadata);
      }

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

  let defaultCommodity: string | null = null;

  const lines = content.split("\n");
  let i = 0;
  let inBlockComment = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // hledger block comments: `comment` ... `end comment`
    if (fmt === "hledger") {
      if (inBlockComment) {
        if (trimmed === "end comment") {
          inBlockComment = false;
        }
        i++;
        continue;
      }
      if (trimmed === "comment") {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (
      !trimmed ||
      trimmed.startsWith(";") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") && !tryParseDatePrefix(trimmed)
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

    // Beancount: skip `option`, `plugin`, `note`, `document`, `event`, `custom`, `include` directives
    if (fmt === "beancount") {
      if (
        /^(option|plugin|note|document|event|custom|include)\s/.test(trimmed)
      ) {
        i++;
        continue;
      }
    }

    // ledger: `commodity` directive sets default commodity
    if (fmt === "ledger" && trimmed.startsWith("commodity ")) {
      const code = trimmed.substring(10).trim().split(/\s+/)[0];
      if (code && !defaultCommodity) {
        defaultCommodity = code;
      }
      i++;
      continue;
    }

    // hledger: skip `include` directive (handled externally), `commodity` directive
    if (fmt === "hledger") {
      if (trimmed.startsWith("include ")) {
        i++;
        continue;
      }
      if (trimmed.startsWith("commodity ")) {
        i++;
        continue;
      }
    }

    // hledger: `account` directive (no date prefix)
    if (fmt === "hledger" && trimmed.startsWith("account ")) {
      const accountName = trimmed.substring(8).trim().split(/\s+/)[0];
      if (accountName) {
        // Use a fallback date for undated account declarations
        await ensureAccount(accountName, [], "1970-01-01");
      }
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
        const consumed = await parseOpenDirective(
          date,
          rest.substring(5).trim(),
          i + 1,
          lines,
          i,
        );
        i += consumed;
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

      // Beancount: `price` directive → exchange rate
      if (rest.startsWith("price ")) {
        const priceTokens = rest.split(/\s+/);
        if (priceTokens.length >= 4) {
          const fromCommodity = priceTokens[1];
          const rate = priceTokens[2];
          const toCommodity = priceTokens[3];
          try {
            new Decimal(rate);
            await ensureCurrency(fromCommodity);
            await ensureCurrency(toCommodity);
            await backend.recordExchangeRate({
              id: uuidv7(),
              date,
              from_currency: fromCommodity,
              to_currency: toCommodity,
              rate,
              source: "ledger-file",
            });
            result.prices_imported++;
          } catch {
            result.warnings.push(
              `line ${i + 1}: malformed price directive`,
            );
          }
        }
        i++;
        continue;
      }

      // Beancount: `commodity` directive → ensure currency exists, skip metadata lines
      if (rest.startsWith("commodity ")) {
        const code = rest.substring(10).trim().split(/\s+/)[0];
        if (code) {
          await ensureCurrency(code);
        }
        // Skip following metadata lines (indented)
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i])) {
          i++;
        }
        continue;
      }

      // Beancount: skip `note`, `document`, `event`, `custom` directives with date prefix
      if (fmt === "beancount") {
        if (
          /^(note|document|event|custom)\s/.test(rest)
        ) {
          i++;
          continue;
        }
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

  // Check deferred balance assertions now that all transactions are imported
  for (const ba of deferredBalanceAssertions) {
    const acc = existingAccounts.get(ba.accountName);
    if (!acc) {
      result.warnings.push(
        `line ${ba.lineNum}: balance assertion for unknown account '${ba.accountName}'`,
      );
      continue;
    }
    const balances = await backend.getAccountBalance(acc.id, ba.date);
    const actual = balances.find((b) => b.currency === ba.commodity);
    const actualAmount = actual ? new Decimal(actual.amount) : new Decimal(0);
    const expected = new Decimal(ba.amountStr);

    if (!actualAmount.eq(expected)) {
      result.warnings.push(
        `line ${ba.lineNum}: balance assertion failed for ${ba.accountName} ${ba.commodity} ${ba.date} (expected ${ba.amountStr}, actual ${actualAmount.toString()})`,
      );
    }
  }

  return result;
}

// ---- Export ----

export async function exportLedger(
  backend: Backend,
  format: LedgerFormat = "ledger",
): Promise<string> {
  let out = "; Generated by dledger\n\n";

  const accounts = await backend.listAccounts();
  const sorted = [...accounts].sort((a, b) => {
    const dateCompare = a.created_at.localeCompare(b.created_at);
    return dateCompare !== 0
      ? dateCompare
      : a.full_name.localeCompare(b.full_name);
  });

  for (const acc of sorted) {
    if (format === "hledger") {
      // hledger: `account Acct`
      out += `account ${acc.full_name}\n`;
      // Account metadata as comments
      try {
        const meta = await backend.getAccountMetadata(acc.id);
        for (const [key, value] of Object.entries(meta)) {
          out += `  ; ${key}: ${value}\n`;
        }
      } catch {
        // skip on error
      }
    } else {
      // ledger / beancount: `YYYY-MM-DD open Acct`
      const commodities =
        acc.allowed_currencies.length > 0
          ? `  ${acc.allowed_currencies.join(",")}`
          : "";
      out += `${acc.created_at} open ${acc.full_name}${commodities}\n`;
      // Account metadata
      try {
        const meta = await backend.getAccountMetadata(acc.id);
        for (const [key, value] of Object.entries(meta)) {
          if (format === "beancount") {
            out += `  ${key}: "${value}"\n`;
          } else {
            out += `  ; ${key}: ${value}\n`;
          }
        }
      } catch {
        // skip on error
      }
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

    if (format === "beancount") {
      // Beancount: quoted description
      out += `${entry.date}${statusMarker} "${entry.description}"\n`;
      // Emit transaction metadata
      try {
        const meta = await backend.getMetadata(entry.id);
        for (const [key, value] of Object.entries(meta)) {
          if (key === "tags" || key === "links") continue;
          out += `  ${key}: "${value}"\n`;
        }
      } catch {
        // skip on error
      }
    } else if (format === "hledger") {
      out += `${entry.date}${statusMarker} ${entry.description}\n`;
      // Emit transaction metadata as comments
      try {
        const meta = await backend.getMetadata(entry.id);
        for (const [key, value] of Object.entries(meta)) {
          if (key === "tags" || key === "links") continue;
          out += `  ; ${key}: ${value}\n`;
        }
      } catch {
        // skip on error
      }
    } else {
      out += `${entry.date}${statusMarker} ${entry.description}\n`;
    }

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
