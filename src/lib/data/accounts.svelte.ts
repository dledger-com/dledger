import type { Account, AccountType, Currency, CurrencyBalance } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";
import { invalidate } from "$lib/data/invalidation.js";

// Module-level cache (persists across SPA navigations)
let _cachedAccounts = $state<Account[]>([]);
let _cachedCurrencies = $state<Currency[]>([]);
let _cacheLoaded = false;

export function preWarmAccountCache(accounts: Account[], currencies: Currency[]) {
  _cachedAccounts = accounts;
  _cachedCurrencies = currencies;
  _cacheLoaded = true;
}

export class AccountStore {
  accounts = $state<Account[]>(_cachedAccounts);
  currencies = $state<Currency[]>(_cachedCurrencies);
  loading = $state(!_cacheLoaded);
  error = $state<string | null>(null);

  readonly active = $derived(this.accounts.filter((a) => !a.is_archived));

  readonly byType = $derived(
    this.active.reduce(
      (map, acc) => {
        const list = map.get(acc.account_type) ?? [];
        list.push(acc);
        map.set(acc.account_type, list);
        return map;
      },
      new Map<AccountType, Account[]>(),
    ),
  );

  readonly byId = $derived(
    new Map(this.accounts.map((a) => [a.id, a])),
  );

  readonly archivedCount = $derived(this.accounts.filter((a) => a.is_archived).length);

  readonly postable = $derived(this.active.filter((a) => a.is_postable));

  /** @deprecated Use settings.currency instead — baseCurrency from AccountStore is no longer reliable. */
  readonly baseCurrency: Currency | null = null;

  async load() {
    if (!_cacheLoaded) this.loading = true;
    this.error = null;
    try {
      const [accounts, currencies] = await Promise.all([
        getBackend().listAccounts(),
        getBackend().listCurrencies(),
      ]);
      _cachedAccounts = accounts;
      _cachedCurrencies = currencies;
      _cacheLoaded = true;
      this.accounts = accounts;
      this.currencies = currencies;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async create(account: Account): Promise<boolean> {
    try {
      await getBackend().createAccount(account);
      await this.load();
      invalidate("accounts");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async update(id: string, updates: { full_name?: string; is_postable?: boolean }): Promise<boolean> {
    try {
      await getBackend().updateAccount(id, updates);
      await this.load();
      invalidate("accounts", "reports");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async archive(id: string): Promise<boolean> {
    try {
      await getBackend().archiveAccount(id);
      await this.load();
      invalidate("accounts");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async unarchive(id: string): Promise<boolean> {
    try {
      await getBackend().unarchiveAccount(id);
      await this.load();
      invalidate("accounts");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async createCurrency(currency: Currency): Promise<boolean> {
    try {
      await getBackend().createCurrency(currency);
      this.currencies = await getBackend().listCurrencies();
      invalidate("currencies");
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async merge(sourceId: string, targetId: string): Promise<{ lineItems: number; lots: number; assertions: number; reconciliations: number; metadata: number } | null> {
    try {
      const result = await getBackend().mergeAccounts(sourceId, targetId);
      await this.load();
      invalidate("accounts", "journal", "reports");
      return result;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async getBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return getBackend().getAccountBalance(accountId, asOf);
  }

  async getBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return getBackend().getAccountBalanceWithChildren(accountId, asOf);
  }
}
