import { v7 as uuidv7 } from "uuid";
import { RateLimitedFetcher } from "./utils/rate-limited-fetch.js";
import type { Backend, CurrencyRateOverride } from "./backend.js";
import { createDpriceClient, type DpriceClient, type DpriceAssetFilter, type DpriceAssetType } from "./dprice-client.js";
import { isDpriceActive, type DpriceMode } from "./data/settings.svelte.js";
import { COINGECKO_IDS, resolveGeckoId, isValidGeckoId, hasGeckoId, CHAIN_TO_PLATFORM, refreshCoinGeckoIds } from "./coingecko-ids.js";
import { getSupportedVsCurrencies, isVsCurrencySupported } from "./coingecko-vs-currencies.js";

// ECB/Frankfurter supported fiat currency codes
const FRANKFURTER_FIAT = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

export interface ExchangeRateSyncResult {
  rates_fetched: number;
  rates_skipped: number;
  errors: string[];
  autoHidden: string[];
  newlyDetected: string[]; // currencies auto-detected this run
}

interface FrankfurterResponse {
  date: string;
  rates: Record<string, number>;
}

interface CoinGeckoResponse {
  [id: string]: { [vsCurrency: string]: number };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export type SourceName = "frankfurter" | "coingecko" | "finnhub" | "defillama" | "cryptocompare" | "binance" | "dprice";

/** Auto-detect the best source for a currency using static heuristics */
function autoDetectSource(
  code: string,
  assetType: string,
  baseCurrency: string,
  hasTokenAddress: boolean,
  dpriceAssets?: Set<string>,
  disabledSources?: Set<string>,
  geckoIdMap?: Map<string, string>,
): SourceName | "none" {
  // When dprice is enabled and the asset is available locally, prefer it
  if (dpriceAssets && dpriceAssets.has(code)) return "dprice";
  // Asset-type based routing (when classified)
  if (assetType === "fiat" && FRANKFURTER_FIAT.has(baseCurrency)) {
    return disabledSources?.has("frankfurter") ? "none" : "frankfurter";
  }
  if (assetType === "crypto") {
    // Trust the "crypto" classification — try all crypto sources even for unknown symbols.
    // DefiLlama accepts arbitrary symbols (searches by symbol), so it can handle non-hardcoded tokens.
    if (!disabledSources?.has("defillama")) return "defillama";
    if ((hasTokenAddress || hasGeckoId(code, geckoIdMap)) && !disabledSources?.has("coingecko")) return "coingecko";
    if (!disabledSources?.has("binance")) return "binance";
    return "none";
  }
  if (assetType === "stock") return "none"; // finnhub requires API key; dprice handles stocks
  if (assetType === "commodity" || assetType === "index" || assetType === "bond") return "none";
  // Unclassified fallback: existing heuristics
  if (FRANKFURTER_FIAT.has(code) && FRANKFURTER_FIAT.has(baseCurrency)) {
    return disabledSources?.has("frankfurter") ? "none" : "frankfurter";
  }
  if (hasTokenAddress || hasGeckoId(code, geckoIdMap)) {
    if (!disabledSources?.has("defillama")) return "defillama";
    if (!disabledSources?.has("coingecko")) return "coingecko";
    if (!disabledSources?.has("binance")) return "binance";
    return "none";
  }
  // Last resort: try defillama for any unclassified currency (it searches by symbol)
  if (!disabledSources?.has("defillama")) return "defillama";
  return "none";
}

/**
 * Resolve a currency against dprice's asset database using all available metadata.
 * Returns the dprice asset ID on unambiguous match, or "none"/"ambiguous" otherwise.
 *
 * Disambiguation cascade (when multiple results):
 * 1. Contract address match (via filter or local match)
 * 2. Chain match via originChain hint (e.g., "hyperliquid")
 * 3. Asset type filter
 * 4. Has-prices filter (eliminate dead assets)
 * 5. Name match
 */
export async function resolveDpriceAsset(
  client: DpriceClient,
  code: string,
  assetType: string,
  tokenAddr?: { chain: string; contract_address: string },
  hints?: {
    name?: string;
    originChain?: string;
  },
): Promise<{ id: string; type: string; coingecko_id?: string } | "none" | "ambiguous"> {
  // Query with symbol + type (when known) to get the best candidates,
  // then disambiguate locally with richer heuristics.
  // Fallback: if typed query returns nothing, retry with symbol-only so the
  // disambiguation cascade (step 3: type filter) can still pick the right asset.
  let results = await client.queryAssets(
    assetType ? { symbol: code, type: assetType as DpriceAssetType } : { symbol: code },
    10,
  );
  if (results.length === 0 && assetType) {
    results = await client.queryAssets({ symbol: code }, 10);
  }
  if (results.length === 0) return "none";
  if (results.length === 1) return { id: results[0].id, type: String(results[0].type), coingecko_id: results[0].coingecko_id ?? undefined };

  const pick = (r: typeof results[0]) => ({ id: r.id, type: String(r.type), coingecko_id: r.coingecko_id ?? undefined });
  let candidates = results;

  // 1. Contract address match (strongest signal)
  if (tokenAddr) {
    const byContract = candidates.filter(
      (r) => r.contract_address?.toLowerCase() === tokenAddr.contract_address.toLowerCase()
        && r.contract_chain?.toLowerCase() === tokenAddr.chain.toLowerCase(),
    );
    if (byContract.length === 1) return pick(byContract[0]);
    if (byContract.length > 1) candidates = byContract;
  }

  // 2. Chain match via origin hint (e.g., DEPIN from Hyperliquid → prefer hyperliquid chain)
  if (hints?.originChain && candidates.length > 1) {
    const byChain = candidates.filter(
      (r) => r.contract_chain?.toLowerCase() === hints.originChain!.toLowerCase(),
    );
    if (byChain.length === 1) return pick(byChain[0]);
    if (byChain.length > 1) candidates = byChain;
  }

  // 3. Asset type filter
  if (assetType && candidates.length > 1) {
    const byType = candidates.filter((r) => r.type === assetType);
    if (byType.length === 1) return pick(byType[0]);
    if (byType.length > 1) candidates = byType;
  }

  // 4. Has prices — prefer assets with actual price data
  if (candidates.length > 1) {
    const withPrices = candidates.filter((r) => r.first_price_date != null);
    if (withPrices.length === 1) return pick(withPrices[0]);
    if (withPrices.length > 1) candidates = withPrices;
  }

  // 5. Name match — prefer exact name match with currency name
  if (hints?.name && candidates.length > 1) {
    const nameLower = hints.name.toLowerCase();
    const byName = candidates.filter((r) => r.name.toLowerCase() === nameLower);
    if (byName.length === 1) return pick(byName[0]);
  }

  // 6. Best candidate — when multiple assets remain, prefer the one with
  // the most recent price data (most actively tracked in dprice)
  if (candidates.length > 1) {
    const sorted = [...candidates].sort((a, b) => {
      const aDate = a.last_price_date ?? "";
      const bDate = b.last_price_date ?? "";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      // Tie-break: longest history (earliest first_price_date)
      const aFirst = a.first_price_date ?? "9999";
      const bFirst = b.first_price_date ?? "9999";
      return aFirst.localeCompare(bFirst);
    });
    return pick(sorted[0]);
  }

  return "ambiguous";
}

type DpriceResolveResult = { id: string; type: string; coingecko_id?: string } | "none" | "ambiguous";

/**
 * Batch-resolve multiple currencies against dprice in a single query.
 * Applies the same disambiguation cascade as resolveDpriceAsset() per symbol.
 */
export async function resolveDpriceAssetsBatch(
  client: DpriceClient,
  requests: Array<{
    code: string;
    assetType: string;
    tokenAddr?: { chain: string; contract_address: string };
    hints?: { name?: string; originChain?: string };
  }>,
): Promise<Map<string, DpriceResolveResult>> {
  if (requests.length === 0) return new Map();

  const uniqueSymbols = [...new Set(requests.map(r => r.code))];
  const allCandidates = await client.queryAssetsBatch(uniqueSymbols, 10);

  const results = new Map<string, DpriceResolveResult>();
  for (const req of requests) {
    if (results.has(req.code)) continue; // already resolved (dedup)
    const candidates = allCandidates.get(req.code.toUpperCase()) ?? [];
    if (candidates.length === 0) { results.set(req.code, "none"); continue; }
    if (candidates.length === 1) {
      results.set(req.code, { id: candidates[0].id, type: String(candidates[0].type), coingecko_id: candidates[0].coingecko_id ?? undefined });
      continue;
    }

    // Disambiguation cascade (same as resolveDpriceAsset)
    const pick = (r: typeof candidates[0]) => ({ id: r.id, type: String(r.type), coingecko_id: r.coingecko_id ?? undefined });
    let pool = candidates;

    // 1. Contract address match
    if (req.tokenAddr) {
      const byContract = pool.filter(
        r => r.contract_address?.toLowerCase() === req.tokenAddr!.contract_address.toLowerCase()
          && r.contract_chain?.toLowerCase() === req.tokenAddr!.chain.toLowerCase(),
      );
      if (byContract.length === 1) { results.set(req.code, pick(byContract[0])); continue; }
      if (byContract.length > 1) pool = byContract;
    }

    // 2. Chain match via origin hint
    if (req.hints?.originChain && pool.length > 1) {
      const byChain = pool.filter(r => r.contract_chain?.toLowerCase() === req.hints!.originChain!.toLowerCase());
      if (byChain.length === 1) { results.set(req.code, pick(byChain[0])); continue; }
      if (byChain.length > 1) pool = byChain;
    }

    // 3. Asset type filter
    if (req.assetType && pool.length > 1) {
      const byType = pool.filter(r => r.type === req.assetType);
      if (byType.length === 1) { results.set(req.code, pick(byType[0])); continue; }
      if (byType.length > 1) pool = byType;
    }

    // 4. Has prices
    if (pool.length > 1) {
      const withPrices = pool.filter(r => r.first_price_date != null);
      if (withPrices.length === 1) { results.set(req.code, pick(withPrices[0])); continue; }
      if (withPrices.length > 1) pool = withPrices;
    }

    // 5. Name match
    if (req.hints?.name && pool.length > 1) {
      const nameLower = req.hints.name.toLowerCase();
      const byName = pool.filter(r => r.name.toLowerCase() === nameLower);
      if (byName.length === 1) { results.set(req.code, pick(byName[0])); continue; }
    }

    // 6. Best candidate by recency
    if (pool.length > 1) {
      const sorted = [...pool].sort((a, b) => {
        const aDate = a.last_price_date ?? "";
        const bDate = b.last_price_date ?? "";
        if (aDate !== bDate) return bDate.localeCompare(aDate);
        const aFirst = a.first_price_date ?? "9999";
        const bFirst = b.first_price_date ?? "9999";
        return aFirst.localeCompare(bFirst);
      });
      results.set(req.code, pick(sorted[0]));
      continue;
    }

    results.set(req.code, "ambiguous");
  }
  return results;
}

/** Map base currency to Binance quote currency and construct trading pair */
function toBinancePair(currency: string, baseCurrency: string): string | null {
  const quoteMap: Record<string, string> = { USD: "USDT", EUR: "EUR" };
  const quote = quoteMap[baseCurrency] ?? baseCurrency;
  return `${currency}${quote}`;
}

/**
 * Simplified exchange rate sync. Uses DB-stored currency_rate_source as single source of truth.
 *
 * For each non-base, non-hidden currency:
 * - Has stored rate_source → use that (skip "none")
 * - No stored source → auto-detect: fiat → frankfurter, else → coingecko
 * - Write auto-detection results to DB inline
 * - Etherscan-only currencies where all sources fail → auto-hide
 */
export async function syncExchangeRates(
  backend: Backend,
  baseCurrency: string,
  coingeckoApiKey: string,
  finnhubApiKey: string,
  hiddenCurrencies: Set<string>,
  cryptoCompareApiKey?: string,
  dpriceMode?: DpriceMode,
  dpriceUrl?: string,
  coingeckoPro?: boolean,
  disabledSources?: Set<string>,
  dpriceApiKey?: string,
): Promise<ExchangeRateSyncResult> {
  const result: ExchangeRateSyncResult = {
    rates_fetched: 0,
    rates_skipped: 0,
    errors: [],
    autoHidden: [],
    newlyDetected: [],
  };

  const today = todayISO();
  const currencies = await backend.listCurrencies();
  const codes = currencies
    .map((c) => c.code)
    .filter((c) => c !== baseCurrency && !hiddenCurrencies.has(c));

  if (codes.length === 0) return result;

  // Batch query: which currencies already have a rate recorded for today (exact date)?
  const filledToday = new Set(
    backend.getExchangeRateCurrenciesOnDate
      ? await backend.getExchangeRateCurrenciesOnDate(today)
      : [],
  );

  // Load stored rate overrides (user/handler only — no auto entries)
  const overrides = await backend.getCurrencyRateOverrides();
  const sourceMap = new Map<string, CurrencyRateOverride>();
  for (const src of overrides) {
    sourceMap.set(src.currency, src);
  }

  // Load token addresses for auto-detection and CoinGecko token_price lookups
  const tokenAddresses = await backend.getCurrencyTokenAddresses();
  const tokenAddrSet = new Set(tokenAddresses.map((t) => t.currency));
  const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));

  // Load dynamic CoinGecko ID map from crypto_asset_info (populated by dprice resolution)
  let geckoIdMap = await backend.listCryptoAssetInfo();

  // Refresh CoinGecko coin list (at most once per 24h) to resolve unknown symbols
  if (coingeckoApiKey) {
    try {
      const userCodes = new Set(codes);
      const freshMap = await refreshCoinGeckoIds(
        userCodes,
        (code, id) => backend.setCryptoAssetCoingeckoId(code, id),
        coingeckoApiKey,
        coingeckoPro,
      );
      // Merge freshly resolved IDs into geckoIdMap
      for (const code of userCodes) {
        const id = freshMap.get(code);
        if (id && !geckoIdMap.has(code)) geckoIdMap.set(code, id);
      }
    } catch { /* non-critical — continue with existing map */ }
  }

  // Build code → asset_type lookup for source detection
  const currencyTypeMap = new Map<string, string>();
  for (const c of currencies) {
    currencyTypeMap.set(c.code, c.asset_type);
  }

  // When dprice is enabled, try it FIRST for all currencies.
  // This dprice-first pass fetches actual rates and records them, avoiding redundant external API calls.
  // It also resolves dprice asset IDs for new currencies and stores them for future queries.
  let dpriceAssets: Set<string> | undefined;
  const dpriceResolvedIds = new Map<string, string>(); // code → dprice asset ID
  const dpriceResolvedTypes = new Map<string, string>(); // code → dprice asset type
  const dpriceServed = new Set<string>(); // codes successfully served by dprice this run
  if (isDpriceActive(dpriceMode)) {
    try {
      const client = createDpriceClient({ dpriceMode, dpriceUrl, dpriceApiKey });
      // Request cross-rates for all codes (including baseCurrency for completeness)
      const entries = await client.getRates([...codes, baseCurrency]);
      dpriceAssets = new Set(entries.map((e) => e.from));

      // Load existing dprice asset IDs from crypto_asset_info
      const existingIds = new Map<string, string>();
      // dprice IDs are now stored in crypto_asset_info, not rate overrides

      // Currencies with stored dprice IDs — use directly
      for (const code of codes) {
        if (existingIds.has(code) && dpriceAssets.has(code)) {
          dpriceResolvedIds.set(code, existingIds.get(code)!);
        }
      }
      if (existingIds.has(baseCurrency)) {
        dpriceResolvedIds.set(baseCurrency, existingIds.get(baseCurrency)!);
      }

      // Resolve new currencies that are in dpriceAssets but don't have stored IDs
      const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));
      const currencyNameMap = new Map(currencies.map((c) => [c.code, c.name]));
      // Build origin chain hints from transaction sources
      const originChainMap = new Map<string, string>();
      if (backend.getCurrencyOrigins) {
        const origins = await backend.getCurrencyOrigins();
        for (const o of origins) {
          if (o.origin === "hyperliquid") originChainMap.set(o.currency, "hyperliquid");
          else if (o.origin === "solana") originChainMap.set(o.currency, "solana");
        }
      }

      const codesToResolve = codes.filter(
        (c) => dpriceAssets!.has(c) && !existingIds.has(c),
      );
      // Also resolve baseCurrency if needed
      if (dpriceAssets.has(baseCurrency) && !existingIds.has(baseCurrency)) {
        codesToResolve.push(baseCurrency);
      }
      if (codesToResolve.length > 0) {
        const batchResults = await resolveDpriceAssetsBatch(client, codesToResolve.map(code => ({
          code,
          assetType: currencyTypeMap.get(code) ?? "",
          tokenAddr: tokenAddrMap.get(code),
          hints: { name: currencyNameMap.get(code), originChain: originChainMap.get(code) ?? tokenAddrMap.get(code)?.chain },
        })));
        for (const [code, resolved] of batchResults) {
          if (resolved !== "none" && resolved !== "ambiguous") {
            dpriceResolvedIds.set(code, resolved.id);
            if (resolved.type) dpriceResolvedTypes.set(code, resolved.type);
            if (resolved.coingecko_id) {
              try { await backend.setCryptoAssetCoingeckoId(code, resolved.coingecko_id); } catch { /* non-critical */ }
            }
          }
        }
      }

      // Filter entries that give us a direct rate to baseCurrency
      const baseRates = entries.filter((e) => e.to === baseCurrency);
      for (const entry of baseRates) {
        const code = entry.from;
        if (code === baseCurrency) continue;
        if (!codes.includes(code)) continue;

        // Respect user-priority source overrides: if user explicitly chose a different source, skip
        const stored = sourceMap.get(code);
        if (stored?.set_by === "user" && stored.rate_source !== null && stored.rate_source !== "dprice") {
          continue;
        }

        // Check if rate already exists today (exact date)
        if (filledToday.has(code)) {
          result.rates_skipped++;
          dpriceServed.add(code);
          continue;
        }

        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: entry.rate,
          source: "dprice",
        });
        result.rates_fetched++;
        dpriceServed.add(code);
        filledToday.add(code);
      }
    } catch {
      // dprice not available — fall through to other sources
    }
  }

  // Build per-source fetch lists
  const frankfurterCodes: string[] = [];
  const coingeckoCodes: string[] = [];
  const finnhubCodes: string[] = [];
  const defillamaCodes: string[] = [];
  const cryptocompareCodes: string[] = [];
  const binanceCodes: string[] = [];
  const dpriceCodes: string[] = [];
  const autoDetectCodes: string[] = []; // codes needing auto-detection

  for (const code of codes) {
    // Skip codes already served by the dprice-first pass
    if (dpriceServed.has(code)) continue;

    // Skip codes that already have a rate recorded today
    if (filledToday.has(code)) { result.rates_skipped++; continue; }

    const stored = sourceMap.get(code);
    if (stored && stored.rate_source !== null) {
      // Has configured source
      if (stored.rate_source === "none") continue; // skip entirely
      if (stored.rate_source === "frankfurter") frankfurterCodes.push(code);
      else if (stored.rate_source === "coingecko") coingeckoCodes.push(code);
      else if (stored.rate_source === "finnhub") finnhubCodes.push(code);
      else if (stored.rate_source === "defillama") defillamaCodes.push(code);
      else if (stored.rate_source === "cryptocompare") cryptocompareCodes.push(code);
      else if (stored.rate_source === "binance") binanceCodes.push(code);
      else if (stored.rate_source === "dprice") dpriceCodes.push(code);
    } else {
      // No stored source → auto-detect
      const detected = autoDetectSource(code, currencyTypeMap.get(code) ?? "", baseCurrency, tokenAddrSet.has(code), dpriceAssets, disabledSources, geckoIdMap);
      if (detected === "none") continue; // No known pricing path — skip
      if (detected === "frankfurter") frankfurterCodes.push(code);
      else if (detected === "coingecko") coingeckoCodes.push(code);
      else if (detected === "finnhub") finnhubCodes.push(code);
      else if (detected === "defillama") defillamaCodes.push(code);
      else if (detected === "cryptocompare") cryptocompareCodes.push(code);
      else if (detected === "binance") binanceCodes.push(code);
      else if (detected === "dprice") dpriceCodes.push(code);
      autoDetectCodes.push(code);
    }
  }

  // Clear arrays for disabled sources — codes routed to disabled sources are silently skipped
  if (disabledSources) {
    if (disabledSources.has("frankfurter")) frankfurterCodes.length = 0;
    if (disabledSources.has("coingecko")) coingeckoCodes.length = 0;
    if (disabledSources.has("finnhub")) finnhubCodes.length = 0;
    if (disabledSources.has("defillama")) defillamaCodes.length = 0;
    if (disabledSources.has("cryptocompare")) cryptocompareCodes.length = 0;
    if (disabledSources.has("binance")) binanceCodes.length = 0;
  }

  // If dprice-first pass failed entirely (dpriceAssets still undefined), re-route dpriceCodes to fallback sources
  if (dpriceCodes.length > 0 && dpriceAssets === undefined) {
    for (const code of dpriceCodes) {
      const fallback = autoDetectSource(code, currencyTypeMap.get(code) ?? "", baseCurrency, tokenAddrSet.has(code), undefined, disabledSources, geckoIdMap);
      if (fallback === "none" || fallback === "dprice") continue;
      if (fallback === "frankfurter") frankfurterCodes.push(code);
      else if (fallback === "coingecko") coingeckoCodes.push(code);
      else if (fallback === "finnhub") finnhubCodes.push(code);
      else if (fallback === "defillama") defillamaCodes.push(code);
      else if (fallback === "cryptocompare") cryptocompareCodes.push(code);
      else if (fallback === "binance") binanceCodes.push(code);
    }
    dpriceCodes.length = 0; // Clear — they've been re-routed
  }

  // Track which auto-detect currencies succeeded
  const autoDetectSuccess = new Set<string>();
  const autoDetectFailed = new Set<string>();

  // Track ALL currencies (not just auto-detect) for auto-hide
  const allSucceeded = new Set<string>();
  const allFailed = new Set<string>();

  // ---- Fiat rates via Frankfurter ----
  if (frankfurterCodes.length > 0) {
    try {
      const symbols = frankfurterCodes.join(",");
      const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${symbols}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`Frankfurter HTTP ${resp.status}: ${resp.statusText}`);
      } else {
        const data: FrankfurterResponse = await resp.json();
        for (const code of frankfurterCodes) {
          const rateValue = data.rates[code];
          if (rateValue == null) {
            result.errors.push(`Frankfurter: no rate for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

          const invertedRate = 1 / rateValue;
          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: baseCurrency,
            rate: invertedRate.toString(),
            source: "frankfurter",
          });
          result.rates_fetched++;
        }
      }
    } catch (err) {
      result.errors.push(`Frankfurter: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Crypto rates via CoinGecko ----
  if (coingeckoCodes.length > 0) {
    if (!coingeckoApiKey) {
      result.errors.push(
        `CoinGecko: no API key provided; skipping ${coingeckoCodes.length} crypto rate(s)`,
      );
      // Mark all as failed for auto-detect
      for (const code of coingeckoCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
        allFailed.add(code);
      }
    } else {
      // Validate that baseCurrency is supported as a CoinGecko vs_currency
      const supportedVs = await getSupportedVsCurrencies(coingeckoApiKey, coingeckoPro);
      if (!isVsCurrencySupported(baseCurrency, supportedVs)) {
        result.errors.push(`CoinGecko: base currency "${baseCurrency}" is not supported as a vs_currency; skipping ${coingeckoCodes.length} rate(s)`);
        for (const code of coingeckoCodes) {
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
        }
      } else {
      const geckoFetch = new RateLimitedFetcher({ maxRequests: coingeckoPro ? 100 : 30, intervalMs: 60_000 });
      try {
        const vsBase = baseCurrency.toLowerCase();
        const geckoHeaders: Record<string, string> = coingeckoPro
          ? { "x-cg-pro-api-key": coingeckoApiKey }
          : { "x-cg-demo-api-key": coingeckoApiKey };
        const geckoBase = coingeckoPro
          ? "https://pro-api.coingecko.com/api/v3"
          : "https://api.coingecko.com/api/v3";

        // Separate tokens: those with a known gecko ID use /simple/price,
        // those with only a contract address use /simple/token_price/{platform}
        const idMap = new Map<string, string>(); // geckoId → ticker
        const geckoIds: string[] = [];
        const tokenPriceCodes: Array<{ code: string; chain: string; address: string }> = [];

        for (const code of coingeckoCodes) {
          const geckoId = resolveGeckoId(code, geckoIdMap);
          if (isValidGeckoId(geckoId) && (hasGeckoId(code, geckoIdMap) || geckoId !== code.toLowerCase())) {
            idMap.set(geckoId, code);
            geckoIds.push(geckoId);
          } else {
            // No known gecko ID — try contract address for token_price endpoint
            const tokenAddr = tokenAddrMap.get(code);
            if (tokenAddr && CHAIN_TO_PLATFORM[tokenAddr.chain]) {
              tokenPriceCodes.push({ code, chain: tokenAddr.chain, address: tokenAddr.contract_address });
            } else if (isValidGeckoId(geckoId)) {
              // Last resort: try lowercase code as gecko ID
              idMap.set(geckoId, code);
              geckoIds.push(geckoId);
            } else {
              result.errors.push(`CoinGecko: skipping invalid ID for ${code}`);
              if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
              allFailed.add(code);
            }
          }
        }

        // Fetch prices by CoinGecko ID (batch all into one call)
        if (geckoIds.length > 0) {
          const ids = geckoIds.join(",");
          const url = `${geckoBase}/simple/price?ids=${ids}&vs_currencies=${vsBase}`;
          const resp = await geckoFetch.fetch(url, { headers: geckoHeaders });

          if (!resp.ok) {
            result.errors.push(`CoinGecko HTTP ${resp.status}: ${resp.statusText}`);
            for (const [, ticker] of idMap) {
              if (autoDetectCodes.includes(ticker)) autoDetectFailed.add(ticker);
              allFailed.add(ticker);
            }
          } else {
            const data: CoinGeckoResponse = await resp.json();
            for (const [geckoId, ticker] of idMap) {
              const priceData = data[geckoId];
              if (!priceData || priceData[vsBase] == null) {
                result.errors.push(`CoinGecko: no rate for ${ticker} (id: ${geckoId})`);
                if (autoDetectCodes.includes(ticker)) autoDetectFailed.add(ticker);
                allFailed.add(ticker);
                continue;
              }

              if (autoDetectCodes.includes(ticker)) autoDetectSuccess.add(ticker);
              allSucceeded.add(ticker);

              const rate = priceData[vsBase];
              await backend.recordExchangeRate({
                id: uuidv7(),
                date: today,
                from_currency: ticker,
                to_currency: baseCurrency,
                rate: rate.toString(),
                source: "coingecko",
              });
              result.rates_fetched++;
            }
          }
        }

        // Fetch token prices by contract address (grouped by platform)
        if (tokenPriceCodes.length > 0) {
          const chainGroups = new Map<string, Array<{ code: string; address: string }>>();
          for (const t of tokenPriceCodes) {
            let group = chainGroups.get(t.chain);
            if (!group) { group = []; chainGroups.set(t.chain, group); }
            group.push({ code: t.code, address: t.address });
          }
          for (const [chain, tokens] of chainGroups) {
            const platform = CHAIN_TO_PLATFORM[chain];
            if (!platform) continue;
            const addresses = tokens.map((t) => t.address).join(",");
            const url = `${geckoBase}/simple/token_price/${platform}?contract_addresses=${addresses}&vs_currencies=${vsBase}`;
            try {
              const resp = await geckoFetch.fetch(url, { headers: geckoHeaders });
              if (!resp.ok) {
                result.errors.push(`CoinGecko token_price HTTP ${resp.status} for ${chain}`);
                for (const t of tokens) {
                  if (autoDetectCodes.includes(t.code)) autoDetectFailed.add(t.code);
                  allFailed.add(t.code);
                }
                continue;
              }
              const data: Record<string, Record<string, number>> = await resp.json();
              for (const t of tokens) {
                const priceData = data[t.address];
                if (!priceData || priceData[vsBase] == null) {
                  result.errors.push(`CoinGecko: no token price for ${t.code} (${chain}:${t.address})`);
                  if (autoDetectCodes.includes(t.code)) autoDetectFailed.add(t.code);
                  allFailed.add(t.code);
                  continue;
                }
                if (autoDetectCodes.includes(t.code)) autoDetectSuccess.add(t.code);
                allSucceeded.add(t.code);
                await backend.recordExchangeRate({
                  id: uuidv7(),
                  date: today,
                  from_currency: t.code,
                  to_currency: baseCurrency,
                  rate: priceData[vsBase].toString(),
                  source: "coingecko",
                });
                result.rates_fetched++;
              }
            } catch (err) {
              result.errors.push(`CoinGecko token_price ${chain}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err) {
        result.errors.push(`CoinGecko: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        geckoFetch.dispose();
      }
      }
    }
  }

  // ---- Stock prices via Finnhub ----
  if (finnhubCodes.length > 0) {
    if (!finnhubApiKey) {
      result.errors.push(
        `Finnhub: no API key provided; skipping ${finnhubCodes.length} stock price(s)`,
      );
      for (const code of finnhubCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
        allFailed.add(code);
      }
    } else {
      const finnhubFetch = new RateLimitedFetcher({ maxRequests: 55, intervalMs: 60_000 });
      try {
        for (const code of finnhubCodes) {
          const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}`;
          const resp = await finnhubFetch.fetch(url, { headers: { "X-Finnhub-Token": finnhubApiKey } });

          if (!resp.ok) {
            result.errors.push(`Finnhub HTTP ${resp.status} for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          const data = await resp.json();
          if (!data.c || data.c === 0) {
            result.errors.push(`Finnhub: no price for ${code}`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: "USD",
            rate: data.c.toString(),
            source: "finnhub",
          });
          result.rates_fetched++;
        }
      } catch (err) {
        result.errors.push(`Finnhub: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        finnhubFetch.dispose();
      }
    }
  }

  // ---- CryptoCompare rates (current prices, batch) ----
  if (cryptocompareCodes.length > 0) {
    if (!cryptoCompareApiKey) {
      result.errors.push(
        `CryptoCompare: no API key provided; skipping ${cryptocompareCodes.length} rate(s)`,
      );
      for (const code of cryptocompareCodes) {
        if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
        allFailed.add(code);
      }
    } else {
      try {
        const fsyms = cryptocompareCodes.join(",");
        const url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${fsyms}&tsyms=${baseCurrency}`;
        const resp = await fetch(url, { headers: { authorization: `Apikey ${cryptoCompareApiKey}` } });
        if (!resp.ok) {
          result.errors.push(`CryptoCompare HTTP ${resp.status}: ${resp.statusText}`);
          for (const code of cryptocompareCodes) {
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
          }
        } else {
          const data = await resp.json() as Record<string, Record<string, number>>;
          for (const code of cryptocompareCodes) {
            const priceData = data[code];
            if (!priceData || priceData[baseCurrency] == null) {
              result.errors.push(`CryptoCompare: no rate for ${code}`);
              if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
              allFailed.add(code);
              continue;
            }

            if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
            allSucceeded.add(code);

            await backend.recordExchangeRate({
              id: uuidv7(),
              date: today,
              from_currency: code,
              to_currency: baseCurrency,
              rate: priceData[baseCurrency].toString(),
              source: "cryptocompare",
            });
            result.rates_fetched++;
          }
        }
      } catch (err) {
        result.errors.push(`CryptoCompare: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---- DefiLlama rates (current prices, batch) ----
  if (defillamaCodes.length > 0) {
    try {
      // Build coin identifiers: token addresses or coingecko aliases
      const tokenAddrMap = new Map(tokenAddresses.map((t) => [t.currency, t]));
      const coinIds: string[] = [];
      const coinToCode = new Map<string, string>();
      for (const code of defillamaCodes) {
        const ta = tokenAddrMap.get(code);
        let coinId: string;
        if (ta) {
          coinId = `${ta.chain}:${ta.contract_address}`;
        } else if (hasGeckoId(code, geckoIdMap)) {
          coinId = `coingecko:${resolveGeckoId(code, geckoIdMap)}`;
        } else {
          // No token address and no CoinGecko mapping — skip to avoid garbage API calls
          continue;
        }
        coinIds.push(coinId);
        coinToCode.set(coinId, code);
      }

      // DefiLlama /prices/current supports comma-separated coins
      const url = `https://coins.llama.fi/prices/current/${coinIds.join(",")}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        result.errors.push(`DefiLlama HTTP ${resp.status}: ${resp.statusText}`);
        for (const code of defillamaCodes) {
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
        }
      } else {
        const data = await resp.json() as { coins: Record<string, { price: number; confidence?: number }> };
        for (const [coinId, code] of coinToCode) {
          const priceData = data.coins[coinId];
          if (!priceData || priceData.price == null) {
            result.errors.push(`DefiLlama: no price for ${code} (${coinId})`);
            if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
            allFailed.add(code);
            continue;
          }

          if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
          allSucceeded.add(code);

          // DefiLlama returns USD prices
          const toCurrency = "USD";
          await backend.recordExchangeRate({
            id: uuidv7(),
            date: today,
            from_currency: code,
            to_currency: toCurrency,
            rate: priceData.price.toString(),
            source: "defillama",
          });
          result.rates_fetched++;
        }
      }
    } catch (err) {
      result.errors.push(`DefiLlama: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Binance rates (current prices) ----
  if (binanceCodes.length > 0) {
    try {
      for (const code of binanceCodes) {
        const pair = toBinancePair(code, baseCurrency);
        if (!pair) {
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          result.errors.push(`Binance HTTP ${resp.status} for ${code} (${pair})`);
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        const data = await resp.json() as { price?: string };
        if (!data.price) {
          result.errors.push(`Binance: no price for ${code} (${pair})`);
          if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
          allFailed.add(code);
          continue;
        }

        if (autoDetectCodes.includes(code)) autoDetectSuccess.add(code);
        allSucceeded.add(code);

        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: data.price,
          source: "binance",
        });
        result.rates_fetched++;
      }
    } catch (err) {
      result.errors.push(`Binance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- dprice fallback: mark any unserved dpriceCodes as failed ----
  // These are codes routed to dprice (user-configured or auto-detected) that the dprice-first pass
  // couldn't serve — e.g. dprice was unavailable or didn't have a baseCurrency cross-rate.
  for (const code of dpriceCodes) {
    if (dpriceServed.has(code)) continue;
    if (autoDetectCodes.includes(code)) autoDetectFailed.add(code);
    allFailed.add(code);
  }

  // Post-process: track newly detected currencies (no longer storing auto source assignments)
  for (const code of dpriceServed) {
    allSucceeded.add(code);
    const stored = sourceMap.get(code);
    if (!stored) result.newlyDetected.push(code);
  }
  for (const code of autoDetectSuccess) {
    if (dpriceServed.has(code)) continue;
    result.newlyDetected.push(code);
  }

  // Auto-classify: set asset_type for unclassified currencies based on which source served them
  for (const code of allSucceeded) {
    if (currencyTypeMap.get(code)) continue; // already classified
    const dpriceType = dpriceResolvedTypes.get(code);
    if (dpriceType) {
      await backend.setCurrencyAssetType(code, dpriceType);
    } else if (dpriceServed.has(code)) {
      // dprice served it but we don't have a resolved type — check rate_source_id prefix
      const id = dpriceResolvedIds.get(code) ?? "";
      if (id.startsWith("crypto:")) await backend.setCurrencyAssetType(code, "crypto");
      else if (id.startsWith("fiat:")) await backend.setCurrencyAssetType(code, "fiat");
    } else if (frankfurterCodes.includes(code)) {
      await backend.setCurrencyAssetType(code, "fiat");
    } else if (
      coingeckoCodes.includes(code) || defillamaCodes.includes(code) ||
      cryptocompareCodes.includes(code) || binanceCodes.includes(code)
    ) {
      await backend.setCurrencyAssetType(code, "crypto");
    } else if (finnhubCodes.includes(code)) {
      await backend.setCurrencyAssetType(code, "stock");
    }
  }

  // Record failures for currencies that no source could serve (replaces old auto-"none" marking)
  for (const code of allFailed) {
    if (allSucceeded.has(code)) continue;
    const stored = sourceMap.get(code);
    if (stored && stored.rate_source === "none") continue; // user/handler already suppressed
    try { await backend.recordRateFetchFailure(code, "sync"); } catch { /* ignore */ }
    result.autoHidden.push(code);
  }

  return result;
}

export async function fetchSingleRate(
  backend: Backend,
  code: string,
  source: SourceName,
  baseCurrency: string,
  coingeckoApiKey: string,
  finnhubApiKey: string,
  cryptoCompareApiKey?: string,
  dpriceMode?: DpriceMode,
  dpriceUrl?: string,
  coingeckoPro?: boolean,
  dpriceApiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  const today = todayISO();
  const geckoIdMap = await backend.listCryptoAssetInfo();

  switch (source) {
    case "frankfurter": {
      try {
        const url = `https://api.frankfurter.dev/v1/latest?base=${baseCurrency}&symbols=${code}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `Frankfurter HTTP ${resp.status}: ${resp.statusText}` };
        const data: FrankfurterResponse = await resp.json();
        const rateValue = data.rates[code];
        if (rateValue == null) return { success: false, error: `Frankfurter: no rate for ${code}` };
        const invertedRate = 1 / rateValue;
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: invertedRate.toString(),
          source: "frankfurter",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Frankfurter: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "coingecko": {
      if (!coingeckoApiKey) return { success: false, error: "CoinGecko API key is required" };
      try {
        const geckoId = resolveGeckoId(code, geckoIdMap);
        const vsBase = baseCurrency.toLowerCase();
        const url = coingeckoPro
          ? `https://pro-api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=${vsBase}`
          : `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=${vsBase}`;
        const headers: Record<string, string> = coingeckoPro
          ? { "x-cg-pro-api-key": coingeckoApiKey }
          : { "x-cg-demo-api-key": coingeckoApiKey };
        const resp = await fetch(url, { headers });
        if (!resp.ok) return { success: false, error: `CoinGecko HTTP ${resp.status}: ${resp.statusText}` };
        const data: CoinGeckoResponse = await resp.json();
        const priceData = data[geckoId];
        if (!priceData || priceData[vsBase] == null) return { success: false, error: `CoinGecko: no rate for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: priceData[vsBase].toString(),
          source: "coingecko",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `CoinGecko: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "finnhub": {
      if (!finnhubApiKey) return { success: false, error: "Finnhub API key is required" };
      try {
        const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(code)}`;
        const resp = await fetch(url, { headers: { "X-Finnhub-Token": finnhubApiKey } });
        if (!resp.ok) return { success: false, error: `Finnhub HTTP ${resp.status} for ${code}` };
        const data = await resp.json();
        if (!data.c || data.c === 0) return { success: false, error: `Finnhub: no price for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: "USD",
          rate: data.c.toString(),
          source: "finnhub",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Finnhub: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "defillama": {
      try {
        // Try to get token address, fall back to known coingecko alias
        const tokenAddr = await backend.getCurrencyTokenAddress(code);
        let coinId: string;
        if (tokenAddr) {
          coinId = `${tokenAddr.chain}:${tokenAddr.contract_address}`;
        } else if (hasGeckoId(code, geckoIdMap)) {
          coinId = `coingecko:${resolveGeckoId(code, geckoIdMap)}`;
        } else {
          return { success: false, error: `DefiLlama: no token address or CoinGecko mapping for ${code}` };
        }
        const url = `https://coins.llama.fi/prices/current/${coinId}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `DefiLlama HTTP ${resp.status}: ${resp.statusText}` };
        const data = await resp.json() as { coins: Record<string, { price: number }> };
        const priceData = data.coins[coinId];
        if (!priceData || priceData.price == null) return { success: false, error: `DefiLlama: no price for ${code} (${coinId})` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: "USD",
          rate: priceData.price.toString(),
          source: "defillama",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `DefiLlama: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "cryptocompare": {
      if (!cryptoCompareApiKey) return { success: false, error: "CryptoCompare API key is required" };
      try {
        const url = `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${code}&tsyms=${baseCurrency}`;
        const resp = await fetch(url, { headers: { authorization: `Apikey ${cryptoCompareApiKey}` } });
        if (!resp.ok) return { success: false, error: `CryptoCompare HTTP ${resp.status}: ${resp.statusText}` };
        const data = await resp.json() as Record<string, Record<string, number>>;
        const priceData = data[code];
        if (!priceData || priceData[baseCurrency] == null) return { success: false, error: `CryptoCompare: no rate for ${code}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: priceData[baseCurrency].toString(),
          source: "cryptocompare",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `CryptoCompare: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "binance": {
      try {
        const pair = toBinancePair(code, baseCurrency);
        if (!pair) return { success: false, error: `Binance: cannot form pair for ${code}/${baseCurrency}` };
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
        const resp = await fetch(url);
        if (!resp.ok) return { success: false, error: `Binance HTTP ${resp.status} for ${code} (${pair})` };
        const data = await resp.json() as { price?: string };
        if (!data.price) return { success: false, error: `Binance: no price for ${code} (${pair})` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate: data.price,
          source: "binance",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `Binance: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case "dprice": {
      try {
        const client = createDpriceClient({ dpriceMode, dpriceUrl, dpriceApiKey });
        const rate = await client.getRate(code, baseCurrency);
        if (rate == null) return { success: false, error: `dprice: no rate for ${code}/${baseCurrency}` };
        await backend.recordExchangeRate({
          id: uuidv7(),
          date: today,
          from_currency: code,
          to_currency: baseCurrency,
          rate,
          source: "dprice",
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: `dprice: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
}
