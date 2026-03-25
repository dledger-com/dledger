import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";
import { configureAccountPaths, type AccountPathConfig } from "$lib/accounts/paths.js";
import type { ChartGranularity } from "$lib/utils/chart-granularity.js";
import type { HistoricalFetchConfig } from "$lib/exchange-rate-historical.js";

export type DpriceMode = "off" | "integrated" | "http" | "local";

export function isDpriceActive(mode?: DpriceMode): boolean {
  return !!mode && mode !== "off";
}

export interface AppSettings {
  currency: string;
  dateFormat: string;
  fiscalYearStart: string;
  etherscanApiKey: string;
  coingeckoApiKey: string;
  coingeckoPro?: boolean;
  finnhubApiKey: string;
  cryptoCompareApiKey: string;
  theGraphApiKey: string;
  routescanApiKey: string;
  showHidden: boolean;
  lastRateSync: string;
  debugMode: boolean;
  holdingPeriodDays: number;
  handlers: Record<string, { enabled: boolean; enrichment?: boolean }>;
  /** Global enrichment toggle (replaces per-handler enrichment flags). Default: true */
  enrichmentEnabled?: boolean;
  frenchTax?: {
    initialAcquisitionCost?: string;  // EUR, default "0"
    fiatCurrencies?: string[];        // override defaults
  };
  csvCategorizationRules?: CsvCategorizationRule[];
  mlClassificationEnabled?: boolean;
  mlConfidenceThreshold?: number;
  accountPaths?: Partial<AccountPathConfig>;
  dpriceMode?: DpriceMode;
  dpriceUrl?: string;
  spamCleanupDone?: boolean;
  rateConfigHash?: string;
  // Per-service enable/disable (undefined = enabled for backward compat)
  frankfurterEnabled?: boolean;
  coingeckoEnabled?: boolean;
  cryptoCompareEnabled?: boolean;
  defillamaEnabled?: boolean;
  binanceRatesEnabled?: boolean;  // "binanceRates" to avoid confusion with Binance CEX adapter
  finnhubEnabled?: boolean;
  etherscanEnabled?: boolean;
  routescanEnabled?: boolean;
  theGraphEnabled?: boolean;
  journalAmountBars?: boolean;
  journalShowChart?: boolean;
  journalShowSourceIcons?: boolean;
  journalShowCurrencyIcons?: boolean;
  journalColumnVisibility?: Record<string, boolean>;
  currencyColumnVisibility?: Record<string, boolean>;
  journalChartGranularity?: ChartGranularity | null;
  journalLineItemView?: "table" | "flow";
  locale?: string;
  btcExplorerUrl?: string;  // default: "https://mempool.space"
  heliusApiKey?: string;    // Helius API key for Solana sync
  blockfrostApiKey?: string; // Blockfrost API key for Cardano sync
  moneroLwsUrl?: string;     // Monero Light Wallet Server URL (user-configured, no default)
  onboardingCompleted?: boolean;
  onboardingDismissedChecklist?: boolean;
  dashboardRangePreset?: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  currency: "USD",
  dateFormat: "YYYY-MM-DD",
  fiscalYearStart: "01-01",
  etherscanApiKey: "",
  coingeckoApiKey: "",
  finnhubApiKey: "",
  cryptoCompareApiKey: "",
  theGraphApiKey: "",
  routescanApiKey: "",
  showHidden: false,
  lastRateSync: "",
  debugMode: false,
  holdingPeriodDays: 365,
  handlers: { "generic-etherscan": { enabled: true } },
};

/**
 * Compute a hash of rate-relevant config. When this changes, auto-detected
 * "none" entries should be cleared so currencies get retried.
 */
/** Check if a service is enabled (undefined = enabled for backward compat) */
export function isServiceEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

export function computeRateConfigHash(s: AppSettings): string {
  const parts = [
    s.dpriceMode ?? "off",
    s.coingeckoApiKey ? "set" : "",
    s.finnhubApiKey ? "set" : "",
    s.cryptoCompareApiKey ? "set" : "",
    s.coingeckoPro ? "pro" : "",
    s.frankfurterEnabled === false ? "frank:off" : "",
    s.coingeckoEnabled === false ? "cg:off" : "",
    s.cryptoCompareEnabled === false ? "cc:off" : "",
    s.defillamaEnabled === false ? "dl:off" : "",
    s.binanceRatesEnabled === false ? "bin:off" : "",
    s.finnhubEnabled === false ? "fh:off" : "",
  ];
  return parts.join("|");
}

const STORAGE_KEY = "dledger-settings";

export function loadSettings(): AppSettings {
  return loadFromStorage();
}

function loadFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate old showSpam → showHidden
      if ("showSpam" in parsed && !("showHidden" in parsed)) {
        parsed.showHidden = parsed.showSpam;
      }
      delete parsed.showSpam;
      // Migrate old dpriceEnabled → dpriceMode
      if ("dpriceEnabled" in parsed && !("dpriceMode" in parsed)) {
        parsed.dpriceMode = parsed.dpriceEnabled ? "integrated" : "off";
        delete parsed.dpriceEnabled;
      }
      // Migrate frenchTax.priorAcquisitionCost → initialAcquisitionCost
      if (parsed.frenchTax?.priorAcquisitionCost !== undefined && parsed.frenchTax?.initialAcquisitionCost === undefined) {
        parsed.frenchTax.initialAcquisitionCost = parsed.frenchTax.priorAcquisitionCost;
        delete parsed.frenchTax.priorAcquisitionCost;
      }
      // Migrate per-handler enrichment → global enrichmentEnabled
      if (parsed.enrichmentEnabled === undefined && parsed.handlers) {
        const anyEnrichment = Object.values(parsed.handlers as Record<string, { enrichment?: boolean }>)
          .some((h) => h.enrichment === true);
        if (anyEnrichment) parsed.enrichmentEnabled = true;
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveToStorage(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export class SettingsStore {
  settings = $state<AppSettings>(loadFromStorage());
  loading = $state(false);

  constructor() {
    // Apply saved account paths on construction
    if (this.settings.accountPaths) {
      configureAccountPaths(this.settings.accountPaths);
    }
  }

  get currency() {
    return this.settings.currency;
  }

  get dateFormat() {
    return this.settings.dateFormat;
  }

  get fiscalYearStart() {
    return this.settings.fiscalYearStart;
  }

  get etherscanApiKey() {
    return this.settings.etherscanApiKey;
  }

  get coingeckoApiKey() {
    return this.settings.coingeckoApiKey;
  }

  get finnhubApiKey() {
    return this.settings.finnhubApiKey;
  }

  get cryptoCompareApiKey() {
    return this.settings.cryptoCompareApiKey;
  }

  get theGraphApiKey() {
    return this.settings.theGraphApiKey;
  }

  get showHidden(): boolean {
    return this.settings.showHidden;
  }

  get lastRateSync(): string {
    return this.settings.lastRateSync;
  }

  get debugMode(): boolean {
    return this.settings.debugMode;
  }

  get holdingPeriodDays(): number {
    return this.settings.holdingPeriodDays;
  }

  get locale(): string {
    return this.settings.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
  }

  get onboardingCompleted(): boolean {
    return this.settings.onboardingCompleted ?? false;
  }

  get onboardingDismissedChecklist(): boolean {
    return this.settings.onboardingDismissedChecklist ?? false;
  }

  buildRateConfig(): HistoricalFetchConfig {
    const disabled = new Set<string>();
    if (this.settings.frankfurterEnabled === false) disabled.add("frankfurter");
    if (this.settings.coingeckoEnabled === false) disabled.add("coingecko");
    if (this.settings.cryptoCompareEnabled === false) disabled.add("cryptocompare");
    if (this.settings.defillamaEnabled === false) disabled.add("defillama");
    if (this.settings.binanceRatesEnabled === false) disabled.add("binance");
    if (this.settings.finnhubEnabled === false) disabled.add("finnhub");
    return {
      baseCurrency: this.currency,
      coingeckoApiKey: this.coingeckoApiKey,
      coingeckoPro: this.settings.coingeckoPro,
      finnhubApiKey: this.finnhubApiKey,
      cryptoCompareApiKey: this.cryptoCompareApiKey,
      dpriceMode: this.settings.dpriceMode,
      dpriceUrl: this.settings.dpriceUrl,
      disabledSources: disabled.size > 0 ? disabled : undefined,
    };
  }

  update(partial: Partial<AppSettings>) {
    Object.assign(this.settings, partial);
    saveToStorage(this.settings);
    if (partial.accountPaths !== undefined) {
      configureAccountPaths(this.settings.accountPaths ?? {});
    }
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    saveToStorage(this.settings);
  }
}
