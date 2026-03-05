export type ImportTarget = "csv" | "ofx" | "pdf" | "ledger";

export interface DetectResult {
  target: ImportTarget;
  text?: string;
  bytes?: Uint8Array;
}

const EXTENSION_MAP: Record<string, ImportTarget> = {
  ".csv": "csv",
  ".tsv": "csv",
  ".ofx": "ofx",
  ".qfx": "ofx",
  ".qbo": "ofx",
  ".pdf": "pdf",
  ".ledger": "ledger",
  ".beancount": "ledger",
  ".journal": "ledger",
  ".hledger": "ledger",
  ".dat": "ledger",
  ".zip": "ledger",
};

export function guessFromExtension(fileName: string): ImportTarget | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  return EXTENSION_MAP[fileName.slice(dot).toLowerCase()] ?? null;
}

export function detectFromContent(
  text: string | null,
  bytes: Uint8Array | null,
): ImportTarget | null {
  // PDF: magic bytes %PDF-
  if (bytes && bytes.length >= 5) {
    if (
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46 && // F
      bytes[4] === 0x2d    // -
    ) {
      return "pdf";
    }
  }

  if (!text) return null;

  // OFX: check first 500 chars for OFX markers
  const head = text.slice(0, 500);
  if (/OFXHEADER:/i.test(head) || /<OFX>/i.test(head)) {
    return "ofx";
  }

  // Ledger: score first ~30 non-empty lines for ledger-like patterns
  if (looksLikeLedger(text)) {
    return "ledger";
  }

  // CSV fallback
  return "csv";
}

function looksLikeLedger(text: string): boolean {
  let score = 0;
  let scanned = 0;
  for (const raw of text.split("\n")) {
    if (scanned >= 30) break;
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    scanned++;

    // Date + payee header (e.g. "2024-01-15 Grocery Store")
    if (/^\d{4}[-/]\d{2}[-/]\d{2}\s/.test(line)) score += 2;
    // Indented Account:Path posting
    if (/^\s+\S+:\S+/.test(raw)) score += 1;
    // Beancount directives
    if (/^(open|close|option|plugin|include|txn)\s/.test(line)) score += 3;
    if (/^\d{4}[-/]\d{2}[-/]\d{2}\s+txn\b/.test(line)) score += 3;
    // hledger directives
    if (/^(account|commodity)\s+\S/.test(line)) score += 3;
  }
  return score >= 6;
}

export async function detectImportTarget(
  file: File,
): Promise<DetectResult | null> {
  const extGuess = guessFromExtension(file.name);

  // For PDFs, read as binary
  if (extGuess === "pdf") {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const content = detectFromContent(null, bytes);
    if (content === "pdf") return { target: "pdf", bytes };
    // Extension said PDF but content doesn't confirm — still trust extension
    return { target: "pdf", bytes };
  }

  // For ZIP, no content check needed — always ledger
  if (file.name.toLowerCase().endsWith(".zip")) {
    const buf = await file.arrayBuffer();
    return { target: "ledger", bytes: new Uint8Array(buf) };
  }

  // Text-based formats: read as text
  const text = await readAsText(file);

  // Check binary PDF in case extension was wrong
  const contentGuess = detectFromContent(text, null);

  if (extGuess && contentGuess && extGuess === contentGuess) {
    return { target: extGuess, text };
  }
  if (!extGuess || extGuess === "csv") {
    // Unknown/txt or csv extension — trust content detection
    if (contentGuess) return { target: contentGuess, text };
  }
  if (extGuess && contentGuess && extGuess !== contentGuess) {
    // Disagree — trust content
    return { target: contentGuess, text };
  }
  // Extension known, no strong content signal — trust extension
  if (extGuess) return { target: extGuess, text };

  return contentGuess ? { target: contentGuess, text } : null;
}

function readAsText(file: File): Promise<string> {
  return file.text();
}
