import { v7 as uuidv7 } from "uuid";
import type { HandlerContext } from "$lib/handlers/types.js";
import type { AppSettings } from "$lib/data/settings.svelte.js";
import type { Backend } from "$lib/backend.js";
import type { Account, ChainInfo } from "$lib/types/index.js";

const DEFAULT_CHAIN: ChainInfo = {
  chain_id: 1,
  name: "Ethereum",
  native_currency: "ETH",
  decimals: 18,
};

export function createMockHandlerContext(
  backend: Backend,
  overrides: Partial<HandlerContext> = {},
): HandlerContext {
  const settings: AppSettings = {
    currency: "USD",
    dateFormat: "YYYY-MM-DD",
    fiscalYearStart: "01-01",
    etherscanApiKey: "",
    coingeckoApiKey: "",
    finnhubApiKey: "",
    theGraphApiKey: "",
    showHidden: false,
    lastRateSync: "",
    debugMode: false,
    holdingPeriodDays: 365,
    handlers: {
      "generic-etherscan": { enabled: true },
      "pendle": { enabled: true },
      "uniswap": { enabled: true },
      "aave": { enabled: true },
      "lido": { enabled: true },
      "dex-aggregator": { enabled: true },
      "compound": { enabled: true },
      "curve": { enabled: true },
      "bridge": { enabled: true },
      "yearn": { enabled: true },
      "balancer": { enabled: true },
      "maker": { enabled: true },
      "eigenlayer": { enabled: true },
    },
  };

  const accountCache = new Map<string, string>();

  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: 1,
    label: "TestWallet",
    chain: DEFAULT_CHAIN,
    backend,
    settings,
    async ensureAccount(fullName: string, _date: string): Promise<string> {
      const cached = accountCache.get(fullName);
      if (cached) return cached;

      const accounts = await backend.listAccounts();
      const existing = accounts.find((a: Account) => a.full_name === fullName);
      if (existing) {
        accountCache.set(fullName, existing.id);
        return existing.id;
      }

      const id = uuidv7();
      const parts = fullName.split(":");
      const firstPart = parts[0];
      let accountType: Account["account_type"] = "asset";
      if (firstPart === "Expenses" || firstPart === "Expense") accountType = "expense";
      else if (firstPart === "Income" || firstPart === "Revenue") accountType = "revenue";
      else if (firstPart === "Equity") accountType = "equity";
      else if (firstPart === "Liabilities" || firstPart === "Liability") accountType = "liability";

      await backend.createAccount({
        id,
        parent_id: null,
        account_type: accountType,
        name: parts[parts.length - 1],
        full_name: fullName,
        allowed_currencies: [],
        is_postable: true,
        is_archived: false,
        created_at: "2024-01-01",
      });
      accountCache.set(fullName, id);
      return id;
    },
    async ensureCurrency(code: string, decimals: number): Promise<void> {
      const currencies = await backend.listCurrencies();
      if (currencies.some((c) => c.code === code)) return;
      await backend.createCurrency({
        code,
        name: code,
        decimal_places: decimals,
        is_base: false,
      });
    },
    ...overrides,
  };
}
