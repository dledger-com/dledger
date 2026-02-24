import type { CexAdapter, CexLedgerRecord } from "./types.js";
import { normalizeTxid } from "./pipeline.js";
import { cexFetch, abortableDelay } from "./fetch.js";

const KRAKEN_API = "https://api.kraken.com";

async function krakenFetch(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
  return cexFetch(url, KRAKEN_API, "/api/kraken", init, signal);
}

// Hardcoded Kraken asset code → standard code mapping.
// Kraken uses X-prefixed crypto (XXBT, XETH) and Z-prefixed fiat (ZUSD, ZEUR).
const KRAKEN_ASSET_MAP: Record<string, string> = {
  XXBT: "BTC",
  XBT: "BTC",
  XETH: "ETH",
  XLTC: "LTC",
  XXRP: "XRP",
  XXLM: "XLM",
  XDAO: "DAO",
  XETC: "ETC",
  XREP: "REP",
  XMLN: "MLN",
  XZEC: "ZEC",
  XXMR: "XMR",
  ZUSD: "USD",
  ZEUR: "EUR",
  ZGBP: "GBP",
  ZJPY: "JPY",
  ZCAD: "CAD",
  ZAUD: "AUD",
  ZKRW: "KRW",
  // Some assets use their standard code already
  DOT: "DOT",
  ADA: "ADA",
  SOL: "SOL",
  USDT: "USDT",
  USDC: "USDC",
  DAI: "DAI",
  LINK: "LINK",
  UNI: "UNI",
  AAVE: "AAVE",
  MATIC: "MATIC",
  AVAX: "AVAX",
  ATOM: "ATOM",
};

// Cache for runtime asset resolution via Kraken public API
let assetCache: Map<string, string> | null = null;

async function fetchAssetMap(): Promise<Map<string, string>> {
  if (assetCache) return assetCache;
  try {
    const result = await krakenFetch(`${KRAKEN_API}/0/public/Assets`);
    const json = JSON.parse(result.body);
    if (json.error?.length) throw new Error(json.error[0]);
    const map = new Map<string, string>();
    for (const [krakenCode, info] of Object.entries(json.result as Record<string, { altname: string }>)) {
      map.set(krakenCode, info.altname);
    }
    assetCache = map;
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Sign a Kraken private API request.
 * Signature = HMAC-SHA512(base64decode(secret), path + SHA256(nonce + postData))
 */
async function krakenSign(
  path: string,
  nonce: number,
  postData: string,
  secret: string,
): Promise<string> {
  // SHA256(nonce + postData)
  const encoder = new TextEncoder();
  const sha256Hash = await crypto.subtle.digest("SHA-256", encoder.encode(nonce + postData));

  // Prepend URL path
  const pathBytes = encoder.encode(path);
  const message = new Uint8Array(pathBytes.length + sha256Hash.byteLength);
  message.set(pathBytes, 0);
  message.set(new Uint8Array(sha256Hash), pathBytes.length);

  // Decode base64 secret
  const secretBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));

  // HMAC-SHA512
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, message);

  // Return as base64
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface KrakenLedgerEntry {
  refid: string;
  time: number;
  type: string;
  aclass: string;
  asset: string;
  amount: string;
  fee: string;
  balance: string;
}

interface KrakenLedgersResponse {
  error: string[];
  result?: {
    ledger: Record<string, KrakenLedgerEntry>;
    count: number;
  };
}

function mapKrakenType(type: string): CexLedgerRecord["type"] {
  switch (type) {
    case "trade":
      return "trade";
    case "deposit":
      return "deposit";
    case "withdrawal":
      return "withdrawal";
    case "transfer":
      return "transfer";
    case "staking":
      return "staking";
    default:
      return "other";
  }
}

export class KrakenAdapter implements CexAdapter {
  readonly exchangeId = "kraken" as const;
  readonly exchangeName = "Kraken";

  normalizeAsset(raw: string): string {
    // Try hardcoded map first
    if (KRAKEN_ASSET_MAP[raw]) return KRAKEN_ASSET_MAP[raw];
    // Strip common suffixes like .S (staked), .M (margin), .F (futures)
    const base = raw.replace(/\.[SMFP]$/, "");
    if (KRAKEN_ASSET_MAP[base]) return KRAKEN_ASSET_MAP[base];
    return base;
  }

  async fetchLedgerRecords(
    apiKey: string,
    apiSecret: string,
    since?: number,
    signal?: AbortSignal,
  ): Promise<CexLedgerRecord[]> {
    const records: CexLedgerRecord[] = [];
    let offset = 0;

    // Try to resolve unknown assets via public API
    const dynamicMap = await fetchAssetMap();

    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const nonce = Date.now() * 1000;
      const path = "/0/private/Ledgers";
      const params = new URLSearchParams({
        nonce: String(nonce),
        ofs: String(offset),
      });
      if (since) {
        params.set("start", String(since));
      }
      const postData = params.toString();
      const signature = await krakenSign(path, nonce, postData, apiSecret);

      const fetchInit: RequestInit = {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: postData,
      };

      const result = await krakenFetch(`${KRAKEN_API}${path}`, fetchInit, signal);

      const json = JSON.parse(result.body) as KrakenLedgersResponse;
      if (json.error?.length) {
        throw new Error(`Kraken API error: ${json.error.join(", ")}`);
      }

      const ledger = json.result?.ledger;
      if (!ledger) break;

      const entries = Object.values(ledger);
      if (entries.length === 0) break;

      for (const entry of entries) {
        let asset = this.normalizeAsset(entry.asset);
        // Fallback to dynamic map
        if (asset === entry.asset && dynamicMap.has(entry.asset)) {
          asset = dynamicMap.get(entry.asset)!;
        }

        records.push({
          refid: entry.refid,
          type: mapKrakenType(entry.type),
          asset,
          amount: entry.amount,
          fee: entry.fee,
          timestamp: entry.time,
          txid: null, // Ledgers API doesn't include txid; enriched separately if needed
        });
      }

      offset += entries.length;
      if (offset >= (json.result?.count ?? 0)) break;

      // Rate limit: wait 6 seconds between paginated calls
      await abortableDelay(6000, signal);
    }

    return records;
  }

  /**
   * Fetch on-chain txids for deposit/withdrawal records.
   * Kraken's DepositStatus/WithdrawStatus endpoints provide the on-chain hash.
   */
  async enrichTxids(
    records: CexLedgerRecord[],
    apiKey: string,
    apiSecret: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Build a map of refids that need txids
    const needsTxid = records.filter(
      (r) => (r.type === "deposit" || r.type === "withdrawal") && !r.txid,
    );
    if (needsTxid.length === 0) return;

    // Fetch deposit statuses
    const depositRefids = new Set(needsTxid.filter((r) => r.type === "deposit").map((r) => r.refid));
    if (depositRefids.size > 0) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const txidMap = await this.fetchDepositStatuses(apiKey, apiSecret);
      for (const record of needsTxid) {
        if (record.type === "deposit" && txidMap.has(record.refid)) {
          record.txid = txidMap.get(record.refid)!;
        }
      }
    }

    // Fetch withdrawal statuses
    const withdrawalRefids = new Set(needsTxid.filter((r) => r.type === "withdrawal").map((r) => r.refid));
    if (withdrawalRefids.size > 0) {
      await abortableDelay(6000, signal); // Rate limit
      const txidMap = await this.fetchWithdrawalStatuses(apiKey, apiSecret);
      for (const record of needsTxid) {
        if (record.type === "withdrawal" && txidMap.has(record.refid)) {
          record.txid = txidMap.get(record.refid)!;
        }
      }
    }
  }

  private async fetchDepositStatuses(
    apiKey: string,
    apiSecret: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const nonce = Date.now() * 1000;
    const path = "/0/private/DepositStatus";
    const params = new URLSearchParams({ nonce: String(nonce) });
    const postData = params.toString();
    const signature = await krakenSign(path, nonce, postData, apiSecret);

    try {
      const result = await krakenFetch(`${KRAKEN_API}${path}`, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: postData,
      });
      const json = JSON.parse(result.body);
      if (json.error?.length) return map;

      for (const entry of json.result ?? []) {
        if (entry.refid && entry.txid) {
          map.set(entry.refid as string, normalizeTxid(entry.txid as string));
        }
      }
    } catch {
      // Silently fail — txid enrichment is best-effort
    }
    return map;
  }

  private async fetchWithdrawalStatuses(
    apiKey: string,
    apiSecret: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const nonce = Date.now() * 1000;
    const path = "/0/private/WithdrawStatus";
    const params = new URLSearchParams({ nonce: String(nonce) });
    const postData = params.toString();
    const signature = await krakenSign(path, nonce, postData, apiSecret);

    try {
      const result = await krakenFetch(`${KRAKEN_API}${path}`, {
        method: "POST",
        headers: {
          "API-Key": apiKey,
          "API-Sign": signature,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: postData,
      });
      const json = JSON.parse(result.body);
      if (json.error?.length) return map;

      for (const entry of json.result ?? []) {
        if (entry.refid && entry.txid) {
          map.set(entry.refid as string, normalizeTxid(entry.txid as string));
        }
      }
    } catch {
      // Silently fail
    }
    return map;
  }
}

// Re-export for tests
export { krakenSign, KRAKEN_ASSET_MAP };
