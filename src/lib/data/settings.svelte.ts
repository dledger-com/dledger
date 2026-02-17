export interface AppSettings {
  currency: string;
  dateFormat: string;
  fiscalYearStart: string;
  etherscanApiKey: string;
  hiddenCurrencies: string[];
}

const DEFAULT_SETTINGS: AppSettings = {
  currency: "USD",
  dateFormat: "YYYY-MM-DD",
  fiscalYearStart: "01-01",
  etherscanApiKey: "",
  hiddenCurrencies: [],
};

const STORAGE_KEY = "dledger-settings";

function loadFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
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

  get hiddenCurrencySet(): Set<string> {
    return new Set(this.settings.hiddenCurrencies);
  }

  hideCurrency(code: string) {
    const set = new Set(this.settings.hiddenCurrencies);
    set.add(code);
    this.update({ hiddenCurrencies: [...set] });
  }

  unhideCurrency(code: string) {
    this.update({
      hiddenCurrencies: this.settings.hiddenCurrencies.filter((c) => c !== code),
    });
  }

  resetHiddenCurrencies() {
    this.update({ hiddenCurrencies: [] });
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
