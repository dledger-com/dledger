import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";
import Decimal from "decimal.js-light";

const COINBASE_API = "https://api.coinbase.com";
const COINBASE_HOST = "api.coinbase.com";
const RATE_LIMIT_MS = 100;

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
 * Parse a PEM-encoded private key (PKCS8 format) and import it as a CryptoKey.
 *
 * Supports "-----BEGIN PRIVATE KEY-----" (PKCS8) format directly.
 * SEC1 "-----BEGIN EC PRIVATE KEY-----" format is NOT supported; users should
 * convert with: `openssl pkcs8 -topk8 -nocrypt -in ec.pem -out pkcs8.pem`
 */
function parsePemPrivateKey(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importEcPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
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
  const encoder = new TextEncoder();
  const prehash = `${timestamp}${method}${path}${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(prehash));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

    // 1. Fetch trade fills via Advanced Trade API (JWT auth)
    const tradeRecords = await this.fetchTradeFills(apiKey, apiSecret, since, signal);
    records.push(...tradeRecords);

    // 2. Fetch deposits/withdrawals via V2 API (HMAC auth)
    const txRecords = await this.fetchV2Transactions(apiKey, apiSecret, since, signal);
    records.push(...txRecords);

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
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];

    // First, list all accounts
    const accounts = await this.fetchV2Accounts(apiKey, apiSecret, signal);

    for (const account of accounts) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      let nextUri: string | null = `/v2/accounts/${account.id}/transactions`;

      while (nextUri) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

        const timestamp = String(Math.floor(Date.now() / 1000));
        const hmacSig = await coinbaseHmacSign(apiSecret, timestamp, "GET", nextUri);

        const result = await coinbaseFetch(
          `${COINBASE_API}${nextUri}`,
          {
            method: "GET",
            headers: {
              "CB-ACCESS-KEY": apiKey,
              "CB-ACCESS-SIGN": hmacSig,
              "CB-ACCESS-TIMESTAMP": timestamp,
              "CB-VERSION": "2023-01-01",
            },
          },
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

          // Skip trade types — they're covered by the Advanced Trade fills endpoint
          const txType = mapCoinbaseTransactionType(tx.type, tx.amount.amount);
          if (txType === "trade") continue;

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

      const timestamp = String(Math.floor(Date.now() / 1000));
      const hmacSig = await coinbaseHmacSign(apiSecret, timestamp, "GET", nextUri);

      const result = await coinbaseFetch(
        `${COINBASE_API}${nextUri}`,
        {
          method: "GET",
          headers: {
            "CB-ACCESS-KEY": apiKey,
            "CB-ACCESS-SIGN": hmacSig,
            "CB-ACCESS-TIMESTAMP": timestamp,
            "CB-VERSION": "2023-01-01",
          },
        },
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
