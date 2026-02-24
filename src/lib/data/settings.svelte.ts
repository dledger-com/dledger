import type { CsvCategorizationRule } from "$lib/csv-presets/categorize.js";

export interface AppSettings {
  currency: string;
  dateFormat: string;
  fiscalYearStart: string;
  etherscanApiKey: string;
  coingeckoApiKey: string;
  finnhubApiKey: string;
  cryptoCompareApiKey: string;
  theGraphApiKey: string;
  routescanApiKey: string;
  showHidden: boolean;
  lastRateSync: string;
  debugMode: boolean;
  holdingPeriodDays: number;
  handlers: Record<string, { enabled: boolean; enrichment?: boolean }>;
  frenchTax?: {
    priorAcquisitionCost?: string;  // EUR, default "0"
    fiatCurrencies?: string[];       // override defaults
  };
  csvCategorizationRules?: CsvCategorizationRule[];
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
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_SETTINGS };
}

function saveToStorage(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export class SettingsStore {
  settings = $state<AppSettings>(loadFromStorage());
  loading = $state(false);

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

  update(partial: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...partial };
    saveToStorage(this.settings);
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    saveToStorage(this.settings);
  }
}
