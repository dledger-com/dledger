// Export all app data to a .dledger file (ZIP with JSON, optionally encrypted).

import { zipSync, strToU8 } from "fflate";
import type { Backend } from "../backend.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { loadSettings } from "../data/settings.svelte.js";
import { encrypt } from "./encrypt.js";
import { serializeExport } from "./format.js";
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportHeader, type ExportManifest, type ExportOptions } from "./types.js";

declare const __APP_VERSION__: string;

/**
 * Export all data from the backend + settings to a .dledger binary.
 */
export async function exportData(
	backend: Backend,
	options: ExportOptions = {},
	onProgress?: (message: string) => void,
): Promise<Uint8Array> {
	const settings = loadSettings();
	const includeRaw = options.includeRawTransactions ?? true;
	const includeSettings = options.includeSettings ?? true;
	const includePlugins = options.includePlugins ?? true;

	// 1. Gather all data
	onProgress?.("Gathering accounts...");
	const accounts = await backend.listAccounts();

	onProgress?.("Gathering journal entries...");
	const entriesRaw = await backend.queryJournalEntries({});
	const entries = entriesRaw.map(([entry, items]) => ({
		...entry,
		lineItems: items,
		metadata: null as Record<string, string> | null, // populated below
		links: null as string[] | null,
	}));

	// Batch load metadata and links
	onProgress?.("Gathering metadata...");
	for (const e of entries) {
		try {
			e.metadata = await backend.getMetadata(e.id);
			const links = await backend.getEntryLinks(e.id);
			e.links = links.length > 0 ? links : null;
		} catch { /* optional */ }
	}

	onProgress?.("Gathering currencies...");
	const currencies = await backend.listCurrencies();

	onProgress?.("Gathering exchange rates...");
	const exchangeRates = await backend.listExchangeRates();

	onProgress?.("Gathering sources...");
	const genericChains = [
		"solana", "hyperliquid", "sui", "aptos", "ton", "tezos", "cosmos", "polkadot",
		"doge", "ltc", "bch", "dash", "bsv", "xec", "grs",
		"xrp", "tron", "stellar", "bittensor", "hedera", "near", "algorand", "kaspa", "zcash", "stacks",
		"cardano", "monero", "bitshares",
	];
	const [ethAccounts, btcAccounts, ...genericResults] = await Promise.all([
		backend.listEtherscanAccounts(),
		backend.listBitcoinAccounts(),
		...genericChains.map(chain => backend.listBlockchainAccounts(chain)),
	]);
	const cexAccounts = await backend.listExchangeAccounts();

	const sources: Record<string, unknown> = {
		etherscan: ethAccounts,
		bitcoin: btcAccounts,
	};
	for (let i = 0; i < genericChains.length; i++) {
		sources[genericChains[i]] = genericResults[i];
	}
	sources.cex = cexAccounts.map(a => ({
		...a,
		api_key: options.includeApiKeys ? a.api_key : "***",
		api_secret: options.includeApiKeys ? a.api_secret : "***",
		passphrase: options.includeApiKeys ? a.passphrase : a.passphrase ? "***" : null,
	}));

	onProgress?.("Gathering budgets...");
	const budgets = await backend.listBudgets();
	const reconciliations = await backend.listReconciliations();

	// Raw transactions (optional, can be very large)
	let rawTransactions: Array<{ source: string; data: string }> | undefined;
	if (includeRaw) {
		onProgress?.("Gathering raw transactions...");
		rawTransactions = await backend.queryRawTransactions("");
	}

	// Custom plugins
	let customPlugins: Array<{ id: string; name: string; version: string; description: string; source_code: string; enabled: boolean }> | null = null;
	if (includePlugins) {
		onProgress?.("Gathering plugins...");
		try {
			customPlugins = (await backend.listCustomPlugins()).map(p => ({
				id: p.id, name: p.name, version: p.version, description: p.description,
				source_code: p.source_code, enabled: p.enabled,
			}));
		} catch { /* optional — old schema may lack table */ }
	}

	// 2. Build manifest
	const manifest: ExportManifest = {
		exportVersion: EXPORT_VERSION,
		schemaVersion: 27,
		exportedAt: new Date().toISOString(),
		appVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown",
		entities: {
			accounts: accounts.length,
			journalEntries: entries.length,
			currencies: currencies.length,
			exchangeRates: exchangeRates.length,
			budgets: budgets.length,
			reconciliations: reconciliations.length,
			...(rawTransactions ? { rawTransactions: rawTransactions.length } : {}),
			plugins: customPlugins?.length ?? 0,
		},
	};

	// 3. Build settings export
	const settingsExport = includeSettings ? {
		...settings,
		// Redact API keys unless explicitly included
		...(options.includeApiKeys ? {} : {
			etherscanApiKey: settings.etherscanApiKey ? "***" : "",
			coingeckoApiKey: settings.coingeckoApiKey ? "***" : "",
			finnhubApiKey: settings.finnhubApiKey ? "***" : "",
			cryptoCompareApiKey: settings.cryptoCompareApiKey ? "***" : "",
			theGraphApiKey: settings.theGraphApiKey ? "***" : "",
			routescanApiKey: settings.routescanApiKey ? "***" : "",
			heliusApiKey: settings.heliusApiKey ? "***" : undefined,
		}),
	} : undefined;

	// 4. Create ZIP
	onProgress?.("Building archive...");
	const zipFiles: Record<string, Uint8Array> = {
		"manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
		"accounts.json": strToU8(JSON.stringify(accounts)),
		"journal.json": strToU8(JSON.stringify(entries)),
		"currencies.json": strToU8(JSON.stringify(currencies)),
		"exchange-rates.json": strToU8(JSON.stringify(exchangeRates)),
		"sources.json": strToU8(JSON.stringify(sources)),
		"budgets.json": strToU8(JSON.stringify(budgets)),
		"reconciliations.json": strToU8(JSON.stringify(reconciliations)),
	};

	if (settingsExport) {
		zipFiles["settings.json"] = strToU8(JSON.stringify(settingsExport, null, 2));
	}
	if (rawTransactions) {
		zipFiles["raw-transactions.json"] = strToU8(JSON.stringify(rawTransactions));
	}
	if (customPlugins && customPlugins.length > 0) {
		const pluginsMeta = customPlugins.map(({ source_code: _, ...meta }) => meta);
		zipFiles["plugins.json"] = strToU8(JSON.stringify(pluginsMeta, null, 2));
		for (const p of customPlugins) {
			zipFiles[`plugins/${p.id}.js`] = strToU8(p.source_code);
		}
	}

	const zipBytes = zipSync(zipFiles);

	// 5. Optionally encrypt
	if (options.passphrase) {
		onProgress?.("Encrypting...");
		const { saltBase64, ivBase64, ciphertext } = await encrypt(zipBytes, options.passphrase);
		const header: ExportHeader = {
			format: EXPORT_FORMAT,
			version: EXPORT_VERSION,
			encrypted: true,
			encryption: {
				algorithm: "AES-256-GCM",
				kdf: "PBKDF2",
				kdfHash: "SHA-256",
				iterations: 600_000,
				saltBase64,
				ivBase64,
			},
			createdAt: new Date().toISOString(),
			appVersion: manifest.appVersion,
		};
		return serializeExport(header, ciphertext);
	}

	const header: ExportHeader = {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		encrypted: false,
		createdAt: new Date().toISOString(),
		appVersion: manifest.appVersion,
	};
	return serializeExport(header, zipBytes);
}

/**
 * Trigger a browser download of the exported data.
 */
export function downloadExport(data: Uint8Array, encrypted: boolean): void {
	const date = new Date().toISOString().slice(0, 10);
	const filename = `dledger-export-${date}.dledger${encrypted ? ".enc" : ""}`;
	const blob = new Blob([data], { type: "application/octet-stream" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
