import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import Decimal from "decimal.js-light";
import { hmacSha256Hex } from "./crypto-utils.js";

const COINBASE_API = "https://api.coinbase.com";
const COINBASE_HOST = "api.coinbase.com";
const RATE_LIMIT_MS = 100;

// ---------------------------------------------------------------------------
// Key type detection
// ---------------------------------------------------------------------------

/** CDP keys start with "organizations/"; everything else is a legacy key. */
export function isCdpKey(apiKey: string): boolean {
  return apiKey.startsWith("organizations/");
}

async function coinbaseFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, COINBASE_API, "/api/coinbase", init, signal);
}

// ---------------------------------------------------------------------------
// PEM parsing helpers
// ---------------------------------------------------------------------------

/**
 * DER-encode a length value (short form < 128, long form with 0x81/0x82 prefix).
 */
function derEncodeLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  if (len < 256) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Wrap a SEC1 EC private key (RFC 5915) in a PKCS8 envelope for P-256.
 *
 * PKCS8 structure:
 *   SEQUENCE {
 *     INTEGER 0                           -- version
 *     SEQUENCE {                          -- AlgorithmIdentifier
 *       OID 1.2.840.10045.2.1            -- ecPublicKey
 *       OID 1.2.840.10045.3.1.7          -- prime256v1 (P-256)
 *     }
 *     OCTET STRING { <SEC1 DER bytes> }  -- privateKey
 *   }
 */
function wrapSec1AsPkcs8(sec1Der: Uint8Array): Uint8Array {
  // version INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier: ecPublicKey + prime256v1
  const algId = new Uint8Array([
    0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
    0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ]);
  // OCTET STRING wrapping sec1Der
  const octetTag = new Uint8Array([0x04]);
  const octetLen = derEncodeLength(sec1Der.length);
  // Outer SEQUENCE
  const innerLen =
    version.length + algId.length + octetTag.length + octetLen.length + sec1Der.length;
  const seqTag = new Uint8Array([0x30]);
  const seqLen = derEncodeLength(innerLen);

  const result = new Uint8Array(
    seqTag.length + seqLen.length + innerLen,
  );
  let offset = 0;
  for (const part of [seqTag, seqLen, version, algId, octetTag, octetLen, sec1Der]) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Parse a PEM-encoded private key and return PKCS8 DER bytes.
 *
 * Accepts both PKCS8 ("-----BEGIN PRIVATE KEY-----") and
 * SEC1 ("-----BEGIN EC PRIVATE KEY-----") formats. SEC1 keys are
 * automatically wrapped in a PKCS8 envelope for P-256.
 */
function parsePemPrivateKey(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n"); // literal \n → real newline
  const isSec1 = normalized.includes("EC PRIVATE KEY");
  const stripped = normalized
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(stripped);
  } catch {
    throw new Error(
      "Failed to decode PEM private key — the API secret does not appear to be a valid PEM/base64 string. " +
        "If you are using a legacy Coinbase API key, it is not compatible with the Advanced Trade (JWT) endpoint.",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (isSec1) {
    return wrapSec1AsPkcs8(bytes).buffer;
  }
  return bytes.buffer;
}

async function importEcPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "Failed to import EC private key — ensure the API secret is a valid " +
        "P-256 key in PKCS8 (-----BEGIN PRIVATE KEY-----) or " +
        "SEC1 (-----BEGIN EC PRIVATE KEY-----) format.",
    );
  }
}

// ---------------------------------------------------------------------------
// Base64url encoding (no padding, URL-safe)
// ---------------------------------------------------------------------------

function base64urlEncode(data: Uint8Array | ArrayBuffer): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncodeString(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

// ---------------------------------------------------------------------------
// JWT signing (ES256) for Advanced Trade API
// ---------------------------------------------------------------------------

/**
 * Generate a signed ES256 JWT for the Coinbase Advanced Trade API.
 *
 * @param apiKey - API key name (format: `organizations/.../apiKeys/...`)
 * @param apiSecret - EC private key in PEM PKCS8 format
 * @param method - HTTP method (e.g., "GET", "POST")
 * @param path - Request path (e.g., "/api/v3/brokerage/orders/historical/fills")
 * @returns Signed JWT string
 */
export async function coinbaseSign(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Generate random nonce (16 bytes as hex)
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const header = {
    alg: "ES256",
    kid: apiKey,
    nonce,
    typ: "JWT",
  };

  const payload = {
    sub: apiKey,
    iss: "coinbase-cloud",
    exp: now + 120,
    nbf: now,
    aud: ["retail_rest_api_proxy"],
    uri: `${method} ${COINBASE_HOST}${path}`,
  };

  const encodedHeader = base64urlEncodeString(JSON.stringify(header));
  const encodedPayload = base64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importEcPrivateKey(apiSecret);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64urlEncode(signature);
  return `${signingInput}.${encodedSignature}`;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 signing for V2 API (deposits/withdrawals)
// ---------------------------------------------------------------------------

/**
 * Generate an HMAC-SHA256 signature for the Coinbase V2 API.
 *
 * Prehash string: `timestamp + method + requestPath + body`
 * Result: hex-encoded HMAC-SHA256(secret, prehash)
 *
 * @param secret - API secret (plain string)
 * @param timestamp - Unix timestamp as string
 * @param method - HTTP method (uppercase, e.g., "GET")
 * @param path - Request path (e.g., "/v2/accounts")
 * @param body - Request body (empty string for GET)
 * @returns Hex-encoded signature
 */
export async function coinbaseHmacSign(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string = "",
): Promise<string> {
  const prehash = `${timestamp}${method}${path}${body}`;
  return hmacSha256Hex(secret, prehash);
}

// ---------------------------------------------------------------------------
// V2 auth header builder (CDP → JWT, legacy → HMAC)
// ---------------------------------------------------------------------------

/**
 * Build auth headers for Coinbase V2 API requests.
 *
 * CDP keys use JWT auth (same ES256 signing as Advanced Trade).
 * Legacy keys use HMAC-SHA256 with CB-ACCESS-* headers.
 */
export async function buildV2AuthHeaders(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string,
): Promise<Record<string, string>> {
  if (isCdpKey(apiKey)) {
    const jwt = await coinbaseSign(apiKey, apiSecret, method, path);
    return { Authorization: `Bearer ${jwt}` };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hmacSig = await coinbaseHmacSign(apiSecret, timestamp, method, path);
  return {
    "CB-ACCESS-KEY": apiKey,
    "CB-ACCESS-SIGN": hmacSig,
    "CB-ACCESS-TIMESTAMP": timestamp,
    "CB-VERSION": "2023-01-01",
  };
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface CoinbaseFill {
  trade_id: string;
  product_id: string;
  price: string;
  size: string;
  commission: string;
  side: "BUY" | "SELL";
  order_id: string;
  trade_time: string;
}

interface CoinbaseFillsResponse {
  fills: CoinbaseFill[];
  cursor: string;
}

interface CoinbaseV2Transaction {
  id: string;
  type: string;
  amount: {
    amount: string;
    currency: string;
  };
  native_amount: {
    amount: string;
    currency: string;
  };
  created_at: string;
  network?: {
    hash?: string;
  };
}

interface CoinbaseV2TransactionsResponse {
  data: CoinbaseV2Transaction[];
  pagination: {
    next_uri: string | null;
  };
}

interface CoinbaseV2Account {
  id: string;
  name: string;
  currency: {
    code: string;
  };
  balance: {
    amount: string;
    currency: string;
  };
}

interface CoinbaseV2AccountsResponse {
  data: CoinbaseV2Account[];
  pagination: {
    next_uri: string | null;
  };
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

function mapCoinbaseTransactionType(type: string, amount: string): CexLedgerRecord["type"] {
  switch (type) {
    case "send":
      // Negative amount = withdrawal, positive = deposit (received from someone)
      return new Decimal(amount).isNegative() ? "withdrawal" : "deposit";
    case "fiat_deposit":
    case "exchange_deposit":
    case "pro_deposit":
      return "deposit";
    case "fiat_withdrawal":
    case "exchange_withdrawal":
    case "pro_withdrawal":
      return "withdrawal";
    case "trade":
    case "buy":
    case "sell":
    case "fiat_buy":
    case "fiat_sell":
      return "trade";
    case "transfer":
      return "transfer";
    case "staking_reward":
      return "staking";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// CoinbaseAdapter
// ---------------------------------------------------------------------------

export class CoinbaseAdapter implements CexAdapter {
  readonly exchangeId = "coinbase" as const;
  readonly exchangeName = "Coinbase";

  normalizeAsset(raw: string): string {
    // Coinbase uses standard ticker symbols; no special mapping needed
    return raw;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    if (isCdpKey(apiKey)) {
      // CDP key: JWT auth for Advanced Trade fills + HMAC V2 for deposits/withdrawals
      const tradeRecords = await this.fetchTradeFills(apiKey, apiSecret, since, signal);
      records.push(...tradeRecords);

      const txRecords = await this.fetchV2Transactions(apiKey, apiSecret, since, signal, true);
      records.push(...txRecords);
    } else {
      // Legacy key: HMAC-only V2 API for everything (trades included)
      const txRecords = await this.fetchV2Transactions(apiKey, apiSecret, since, signal, false);
      records.push(...txRecords);
    }

    return records;
  }

  // -------------------------------------------------------------------------
  // Trade fills (Advanced Trade API, JWT auth)
  // -------------------------------------------------------------------------

  private async fetchTradeFills(
    apiKey: string,
    apiSecret: string,
    since: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let cursor = "";

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const path = "/api/v3/brokerage/orders/historical/fills";
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (since) {
        params.set("start_sequence_timestamp", new Date(since * 1000).toISOString());
      }
      const queryString = params.toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;

      const jwt = await coinbaseSign(apiKey, apiSecret, "GET", fullPath);

      const result = await coinbaseFetch(
        `${COINBASE_API}${fullPath}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${jwt}`,
          },
        },
        signal,
      );

      if (result.status !== 200) {
        throw new Error(`Coinbase Advanced Trade API error (${result.status}): ${result.body}`);
      }

      const json = JSON.parse(result.body) as CoinbaseFillsResponse;
      if (!json.fills || json.fills.length === 0) break;

      for (const fill of json.fills) {
        const [base, quote] = fill.product_id.split("-");
        const timestamp = Math.floor(new Date(fill.trade_time).getTime() / 1000);
        const refid = `${fill.product_id}:${fill.trade_id}`;
        const size = new Decimal(fill.size);
        const price = new Decimal(fill.price);
        const quoteAmount = price.mul(size);
        const commission = fill.commission || "0";

        const fillMeta: Record<string, string> = {
          "trade:symbol": fill.product_id,
          "trade:side": fill.side.toLowerCase(),
          "trade:price": fill.price,
          "trade:quantity": fill.size,
          "trade:commission": commission,
          "trade:order_id": fill.order_id,
        };

        // Base asset record
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(base),
          amount: fill.side === "BUY" ? size.toFixed() : size.neg().toFixed(),
          fee: "0",
          timestamp,
          txid: null,
          metadata: fillMeta,
        });

        // Quote asset record (fee applied here)
        records.push({
          refid,
          type: "trade",
          asset: this.normalizeAsset(quote),
          amount: fill.side === "BUY" ? quoteAmount.neg().toFixed() : quoteAmount.toFixed(),
          fee: commission,
          timestamp,
          txid: null,
          metadata: fillMeta,
        });
      }

      cursor = json.cursor;
      if (!cursor) break;

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  // -------------------------------------------------------------------------
  // V2 API transactions (deposits, withdrawals, etc.)
  // -------------------------------------------------------------------------

  private async fetchV2Transactions(
    apiKey: string,
    apiSecret: string,
    since: number | undefined,
    signal: AbortSignal | undefined,
    skipTrades: boolean = true,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // First, list all accounts
    const accounts = await this.fetchV2Accounts(apiKey, apiSecret, signal);

    for (const account of accounts) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let nextUri: string | null = `/v2/accounts/${account.id}/transactions`;

      while (nextUri) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const headers = await buildV2AuthHeaders(apiKey, apiSecret, "GET", nextUri);

        const result = await coinbaseFetch(
          `${COINBASE_API}${nextUri}`,
          { method: "GET", headers },
          signal,
        );

        if (result.status !== 200) {
          // Non-fatal: skip this account on error
          break;
        }

        const json = JSON.parse(result.body) as CoinbaseV2TransactionsResponse;

        for (const tx of json.data) {
          const txTimestamp = Math.floor(new Date(tx.created_at).getTime() / 1000);

          // Skip transactions before `since`
          if (since && txTimestamp < since) continue;

          const txType = mapCoinbaseTransactionType(tx.type, tx.amount.amount);
          // When using CDP keys, trades come from the Advanced Trade fills endpoint
          if (skipTrades && txType === "trade") continue;

          const txid = tx.network?.hash ? normalizeTxid(tx.network.hash) : null;

          const v2Meta: Record<string, string> = {
            "v2:type": tx.type,
          };
          if (tx.native_amount) {
            v2Meta["v2:native_amount"] = tx.native_amount.amount;
            v2Meta["v2:native_currency"] = tx.native_amount.currency;
          }

          records.push({
            refid: tx.id,
            type: txType,
            asset: this.normalizeAsset(tx.amount.currency),
            amount: tx.amount.amount,
            fee: "0", // V2 API doesn't expose fees on transactions directly
            timestamp: txTimestamp,
            txid,
            metadata: v2Meta,
          });
        }

        nextUri = json.pagination.next_uri;

        if (nextUri) {
          await abortableDelay(RATE_LIMIT_MS, signal);
        }
      }

      await abortableDelay(RATE_LIMIT_MS, signal);
    }

    return records;
  }

  private async fetchV2Accounts(
    apiKey: string,
    apiSecret: string,
    signal: AbortSignal | undefined,
  ): Promise<CoinbaseV2Account[]> {
    const accounts: CoinbaseV2Account[] = [];
    let nextUri: string | null = "/v2/accounts";

    while (nextUri) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const headers = await buildV2AuthHeaders(apiKey, apiSecret, "GET", nextUri);

      const result = await coinbaseFetch(
        `${COINBASE_API}${nextUri}`,
        { method: "GET", headers },
        signal,
      );

      if (result.status !== 200) {
        throw new Error(`Coinbase V2 accounts error (${result.status}): ${result.body}`);
      }

      const json = JSON.parse(result.body) as CoinbaseV2AccountsResponse;
      accounts.push(...json.data);

      nextUri = json.pagination.next_uri;

      if (nextUri) {
        await abortableDelay(RATE_LIMIT_MS, signal);
      }
    }

    return accounts;
  }
}
