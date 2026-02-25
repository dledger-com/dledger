export interface OfxTransaction {
  trnType: string;
  dtPosted: string;
  trnAmt: string;
  fitId: string;
  name?: string;
  memo?: string;
  checkNum?: string;
}

export interface OfxAccountInfo {
  bankId?: string;
  acctId?: string;
  acctType?: string;
  accountType: "bank" | "creditcard";
}

export interface OfxBalance {
  balAmt: string;
  dtAsOf: string;
}

export interface OfxStatement {
  currency: string;
  account: OfxAccountInfo;
  transactions: OfxTransaction[];
  ledgerBalance?: OfxBalance;
  availableBalance?: OfxBalance;
}

export interface OfxParseResult {
  statements: OfxStatement[];
  warnings: string[];
}

/**
 * Parse an OFX date string (YYYYMMDD or YYYYMMDDHHMMSS.XXX[offset:TZ]) to YYYY-MM-DD.
 */
export function parseOfxDate(raw: string): string | null {
  if (!raw) return null;
  // Strip timezone info [offset:TZ] and fractional seconds .XXX
  const stripped = raw.replace(/\[.*\]/, "").replace(/\.\d+/, "").trim();
  if (stripped.length < 8) return null;
  const y = stripped.slice(0, 4);
  const m = stripped.slice(4, 6);
  const d = stripped.slice(6, 8);
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

/**
 * Convert SGML-style OFX (v1.x) to valid XML by closing unclosed leaf tags.
 * OFX SGML omits closing tags for leaf elements (e.g. <TRNAMT>100.00).
 */
export function sgmlToXml(sgml: string): string {
  // Step 1: Normalize line endings
  let xml = sgml.replace(/\r\n?/g, "\n");

  // Step 2: Close leaf elements. A leaf element is a tag whose value is on the
  // same line (not followed by another opening tag on the same line).
  // Pattern: <TAG>value terminated by the next tag or end-of-string.
  // Uses lazy match + lookahead to handle both newline-separated and single-line SGML.
  xml = xml.replace(/<(\w+)>([^<]+?)(?=<|$)/g, (match, tag, value, offset, str) => {
    // Skip container tags (value is only whitespace between opening tag and child)
    if (!value.trim()) return match;
    // Don't double-close tags that already have a closing tag
    const afterPos = offset + match.length;
    if (str.startsWith(`</${tag}>`, afterPos)) return match;
    return `<${tag}>${value.trimEnd()}</${tag}>`;
  });

  return xml;
}

function extractTagValue(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
}

function extractAllBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[0]);
  }
  return blocks;
}

function parseTransaction(block: string): OfxTransaction | null {
  const trnType = extractTagValue(block, "TRNTYPE");
  const dtPosted = extractTagValue(block, "DTPOSTED");
  const trnAmt = extractTagValue(block, "TRNAMT");
  const fitId = extractTagValue(block, "FITID");

  if (!trnType || !dtPosted || !trnAmt || !fitId) return null;

  return {
    trnType,
    dtPosted,
    trnAmt,
    fitId,
    name: extractTagValue(block, "NAME"),
    memo: extractTagValue(block, "MEMO"),
    checkNum: extractTagValue(block, "CHECKNUM"),
  };
}

function parseBalance(xml: string, tag: string): OfxBalance | undefined {
  const blocks = extractAllBlocks(xml, tag);
  if (blocks.length === 0) return undefined;
  const block = blocks[0];
  const balAmt = extractTagValue(block, "BALAMT");
  const dtAsOf = extractTagValue(block, "DTASOF");
  if (!balAmt || !dtAsOf) return undefined;
  return { balAmt, dtAsOf };
}

function parseAccountInfo(
  xml: string,
): { account: OfxAccountInfo; accountType: "bank" | "creditcard" } | null {
  // Try bank account first
  const bankBlocks = extractAllBlocks(xml, "BANKACCTFROM");
  if (bankBlocks.length > 0) {
    const block = bankBlocks[0];
    return {
      account: {
        bankId: extractTagValue(block, "BANKID"),
        acctId: extractTagValue(block, "ACCTID"),
        acctType: extractTagValue(block, "ACCTTYPE"),
        accountType: "bank",
      },
      accountType: "bank",
    };
  }

  // Try credit card
  const ccBlocks = extractAllBlocks(xml, "CCACCTFROM");
  if (ccBlocks.length > 0) {
    const block = ccBlocks[0];
    return {
      account: {
        acctId: extractTagValue(block, "ACCTID"),
        accountType: "creditcard",
      },
      accountType: "creditcard",
    };
  }

  return null;
}

function parseStatementBlock(
  xml: string,
  accountType: "bank" | "creditcard",
  warnings: string[],
): OfxStatement | null {
  const currency = extractTagValue(xml, "CURDEF") ?? "USD";

  const accountInfo = parseAccountInfo(xml);
  const account: OfxAccountInfo = accountInfo?.account ?? {
    accountType,
  };

  // Parse transactions
  const txBlocks = extractAllBlocks(xml, "STMTTRN");
  const transactions: OfxTransaction[] = [];
  for (const txBlock of txBlocks) {
    const tx = parseTransaction(txBlock);
    if (tx) {
      transactions.push(tx);
    } else {
      warnings.push("Skipped malformed transaction (missing required fields)");
    }
  }

  const ledgerBalance = parseBalance(xml, "LEDGERBAL");
  const availableBalance = parseBalance(xml, "AVAILBAL");

  return {
    currency,
    account,
    transactions,
    ledgerBalance,
    availableBalance,
  };
}

/**
 * Parse an OFX/QFX/QBO file content into structured data.
 * Handles both SGML (v1.x) and XML (v2.x) formats.
 */
export function parseOfx(content: string): OfxParseResult {
  const warnings: string[] = [];
  const statements: OfxStatement[] = [];

  // Find the <OFX> tag — everything before it is the SGML header
  const ofxStart = content.indexOf("<OFX>");
  if (ofxStart === -1) {
    // Try case-insensitive
    const lower = content.toLowerCase();
    const idx = lower.indexOf("<ofx>");
    if (idx === -1) {
      warnings.push("No <OFX> tag found in file");
      return { statements, warnings };
    }
  }

  // Determine if this is SGML or XML
  const isSgml = !content.includes("<?xml") && !content.includes("<?XML");

  // Extract OFX body
  const ofxIdx = content.toLowerCase().indexOf("<ofx>");
  let body = content.slice(ofxIdx);

  if (isSgml) {
    body = sgmlToXml(body);
  }

  // Parse bank statements (<STMTRS>)
  const bankBlocks = extractAllBlocks(body, "STMTRS");
  for (const block of bankBlocks) {
    const stmt = parseStatementBlock(block, "bank", warnings);
    if (stmt) statements.push(stmt);
  }

  // Parse credit card statements (<CCSTMTRS>)
  const ccBlocks = extractAllBlocks(body, "CCSTMTRS");
  for (const block of ccBlocks) {
    const stmt = parseStatementBlock(block, "creditcard", warnings);
    if (stmt) statements.push(stmt);
  }

  if (statements.length === 0 && warnings.length === 0) {
    warnings.push("No statement data found in OFX file");
  }

  return { statements, warnings };
}
