import type { Account, AccountType, Currency, CurrencyBalance } from "$lib/types/index.js";
import { getBackend } from "$lib/backend.js";

export class AccountStore {
  accounts = $state<Account[]>([]);
  currencies = $state<Currency[]>([]);
  loading = $state(false);
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

  readonly postable = $derived(this.active.filter((a) => a.is_postable));

  readonly baseCurrency = $derived(
    this.currencies.find((c) => c.is_base) ?? null,
  );

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const [accounts, currencies] = await Promise.all([
        getBackend().listAccounts(),
        getBackend().listCurrencies(),
      ]);
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
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getBalance(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return getBackend().getAccountBalance(accountId, asOf);
  }

  async getBalanceWithChildren(accountId: string, asOf?: string): Promise<CurrencyBalance[]> {
    return getBackend().getAccountBalanceWithChildren(accountId, asOf);
  }
}
