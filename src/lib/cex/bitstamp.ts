import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const BITSTAMP_API = "https://www.bitstamp.net";

async function bitstampFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, BITSTAMP_API, "/api/bitstamp", init, signal);
}

/**
 * Known currency fields returned by the Bitstamp user_transactions endpoint.
 * Each trade record contains per-currency amount fields for the currencies involved.
 */
const KNOWN_CURRENCY_FIELDS = new Set([
  "btc", "usd", "eur", "gbp", "eth", "xrp", "ltc", "bch", "pax", "xlm",
  "link", "omg", "usdc", "aave", "algo", "comp", "grt", "mkr", "snx", "uni",
  "yfi", "audio", "crv", "bat", "fet", "knc", "matic", "sushi", "chz", "enj",
  "sand", "storj", "skl", "cel", "axs", "slp", "ada", "sol", "dot", "shib",
  "ftm", "avax", "near", "ape", "imx", "dydx", "flr", "gala", "op", "pepe",
  "sui", "blur", "rndr", "amp", "cvx", "nexo", "mask", "euroc", "gods", "rpl",
  "ldo",
]);

/**
 * Sign a Bitstamp v2 API request.
 *
 * Prehash string:
 *   "BITSTAMP " + apiKey + method + "www.bitstamp.net" + urlPath +
 *   queryString + contentType + nonce + timestamp + "v2" + payload
 *
 * Signature = hex(HMAC-SHA256(secret, prehash))
 */
export async function bitstampSign(
  apiKey: string,
  secret: string,
  method: string,
  urlPath: string,
  queryString: string,
  contentType: string,
  nonce: string,
  timestamp: string,
  payload: string,
): Promise<string> {
  const prehash =
    "BITSTAMP " + apiKey +
    method +
    "www.bitstamp.net" +
    urlPath +
    queryString +
    contentType +
    nonce +
    timestamp +
    "v2" +
    payload;

  const encoder = new TextEncoder();
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

/**
 * A single record from Bitstamp's user_transactions endpoint.
 * Fields vary by transaction type. Trade records include per-currency
 * amount fields (e.g. btc, usd, eth) for the currencies involved.
 */
interface BitstampTransaction {
  id: number;
  type: string; // "0"=deposit, "1"=withdrawal, "2"=trade, "14"=sub account transfer
  datetime: string; // ISO string
  fee: string;
  order_id?: number;
  [key: string]: unknown;
}

function mapBitstampType(type: string): CexLedgerRecord["type"] {
  switch (type) {
    case "0":
      return "deposit";
    case "1":
      return "withdrawal";
    case "2":
      return "trade";
    case "14":
      return "transfer";
    default:
      return "other";
  }
}

/**
 * Find non-zero currency fields in a Bitstamp transaction record.
 * Returns an array of [currencyKey, amountString] pairs.
 */
function findCurrencyFields(tx: BitstampTransaction): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const key of Object.keys(tx)) {
    if (!KNOWN_CURRENCY_FIELDS.has(key)) continue;
    const val = tx[key];
    if (typeof val === "string" && parseFloat(val) !== 0) {
      result.push([key, val]);
    } else if (typeof val === "number" && val !== 0) {
      result.push([key, String(val)]);
    }
  }
  return result;
}

export class BitstampAdapter implements CexAdapter {
  readonly exchangeId = "bitstamp" as const;
  readonly exchangeName = "Bitstamp";

  normalizeAsset(raw: string): string {
    return raw.toUpperCase();
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;
    const limit = 1000;

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const urlPath = "/api/v2/user_transactions/";
      const method = "POST";
      const contentType = "application/x-www-form-urlencoded";
      const nonce = crypto.randomUUID();
      const timestamp = String(Date.now());

      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(limit),
        sort: "asc",
      });
      if (since) {
        params.set("since_timestamp", String(since));
      }
      const payload = params.toString();

      const signature = await bitstampSign(
        apiKey, apiSecret, method, urlPath, "", contentType, nonce, timestamp, payload,
      );

      const fetchInit: RequestInit = {
        method,
        headers: {
          "X-Auth": `BITSTAMP ${apiKey}`,
          "X-Auth-Signature": signature,
          "X-Auth-Nonce": nonce,
          "X-Auth-Timestamp": timestamp,
          "X-Auth-Version": "v2",
          "Content-Type": contentType,
        },
        body: payload,
      };

      const result = await bitstampFetch(
        `${BITSTAMP_API}${urlPath}`, fetchInit, signal,
      );

      const json = JSON.parse(result.body);

      // Bitstamp returns an object with status "error" on failure
      if (json.status === "error" || json.error) {
        const msg = json.reason?.["__all__"]?.[0] ?? json.error ?? "Unknown error";
        throw new Error(`Bitstamp API error: ${msg}`);
      }

      const transactions = json as BitstampTransaction[];
      if (!Array.isArray(transactions) || transactions.length === 0) break;

      for (const tx of transactions) {
        const type = mapBitstampType(tx.type);
        const timestamp_s = new Date(tx.datetime).getTime() / 1000;
        const currencyFields = findCurrencyFields(tx);

        if (type === "trade") {
          // Create two records (one per currency), share the same refid
          const refid = `trade:${tx.id}`;
          const tradeMeta: Record<string, string> | undefined = tx.order_id
            ? { "trade:order_id": String(tx.order_id) }
            : undefined;
          for (const [currKey, amount] of currencyFields) {
            const isSold = parseFloat(amount) < 0;
            records.push({
              refid,
              type: "trade",
              asset: this.normalizeAsset(currKey),
              amount,
              fee: isSold ? tx.fee : "0",
              timestamp: timestamp_s,
              txid: null,
              metadata: tradeMeta,
            });
          }
        } else if (type === "deposit") {
          if (currencyFields.length > 0) {
            const [currKey, amount] = currencyFields[0];
            records.push({
              refid: `deposit:${tx.id}`,
              type: "deposit",
              asset: this.normalizeAsset(currKey),
              amount,
              fee: tx.fee,
              timestamp: timestamp_s,
              txid: null,
            });
          }
        } else if (type === "withdrawal") {
          if (currencyFields.length > 0) {
            const [currKey, amount] = currencyFields[0];
            // Ensure amount is negative for withdrawals
            const absVal = Math.abs(parseFloat(amount));
            records.push({
              refid: `withdraw:${tx.id}`,
              type: "withdrawal",
              asset: this.normalizeAsset(currKey),
              amount: `-${absVal}`,
              fee: tx.fee,
              timestamp: timestamp_s,
              txid: null,
            });
          }
        } else if (type === "transfer") {
          if (currencyFields.length > 0) {
            const [currKey, amount] = currencyFields[0];
            records.push({
              refid: `transfer:${tx.id}`,
              type: "transfer",
              asset: this.normalizeAsset(currKey),
              amount,
              fee: tx.fee,
              timestamp: timestamp_s,
              txid: null,
            });
          }
        } else {
          // "other" — still capture if there's a currency field
          if (currencyFields.length > 0) {
            const [currKey, amount] = currencyFields[0];
            records.push({
              refid: `other:${tx.id}`,
              type: "other",
              asset: this.normalizeAsset(currKey),
              amount,
              fee: tx.fee,
              timestamp: timestamp_s,
              txid: null,
            });
          }
        }
      }

      // If we got fewer than limit, we're done
      if (transactions.length < limit) break;

      offset += transactions.length;

      // Rate limit: 100ms between pages
      await abortableDelay(100, signal);
    }

    return records;
  }
}
