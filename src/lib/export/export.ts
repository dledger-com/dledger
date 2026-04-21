// Export all app data to a .dledger file (ZIP with JSON, optionally encrypted).

import { zipSync, strToU8 } from "fflate";
import type { Backend } from "../backend.js";
import type { AppSettings } from "../data/settings.svelte.js";
import { loadSettings } from "../data/settings.svelte.js";
import { encrypt } from "./encrypt.js";
import { serializeExport } from "./format.js";
import {
	EXPORT_FORMAT,
	EXPORT_VERSION,
	defaultExportSelection,
	type ExportHeader,
	type ExportManifest,
	type ExportOptions,
	type ExportSelection,
	type MlReferencePayload,
} from "./types.js";
import {
	buildHistoricalExamples,
	buildHistoricalTagExamples,
} from "../csv-presets/categorize.js";

declare const __APP_VERSION__: string;

/** Keys in AppSettings that are controlled by the ML layer. */
const ML_RULES_KEY: keyof AppSettings = "csvCategorizationRules";
const ML_SETTINGS_KEYS: Array<keyof AppSettings> = [
	"mlClassificationEnabled",
	"mlConfidenceThreshold",
];

/** API key fields stripped when selection.apiKeys is off. */
const API_KEY_FIELDS: Array<keyof AppSettings> = [
	"etherscanApiKey",
	"coingeckoApiKey",
	"finnhubApiKey",
	"cryptoCompareApiKey",
	"theGraphApiKey",
	"routescanApiKey",
	"heliusApiKey",
];

/**
 * Export all data from the backend + settings to a .dledger binary.
 * `options.selection` controls fine-grained inclusion; defaults include everything
 * except API keys.
 */
export async function exportData(
	backend: Backend,
	options: ExportOptions = {},
	onProgress?: (message: string) => void,
): Promise<Uint8Array> {
	const selection: ExportSelection = options.selection ?? defaultExportSelection();
	const mlActive = selection.mlClassification;
	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown";

	const zipFiles: Record<string, Uint8Array> = {};
	const entities: Record<string, number> = {};

	// --- Accounts ---
	if (selection.accounts) {
		onProgress?.("Gathering accounts...");
		const accounts = await backend.listAccounts();
		zipFiles["accounts.json"] = strToU8(JSON.stringify(accounts));
		entities.accounts = accounts.length;
	}

	// --- Journal entries (with metadata + links) ---
	if (selection.journal) {
		onProgress?.("Gathering journal entries...");
		const entriesRaw = await backend.queryJournalEntries({});
		const entries = entriesRaw.map(([entry, items]) => ({
			...entry,
			lineItems: items,
			metadata: null as Record<string, string> | null,
			links: null as string[] | null,
		}));

		onProgress?.("Gathering metadata...");
		for (const e of entries) {
			try {
				e.metadata = await backend.getMetadata(e.id);
				const links = await backend.getEntryLinks(e.id);
				e.links = links.length > 0 ? links : null;
			} catch { /* optional */ }
		}
		zipFiles["journal.json"] = strToU8(JSON.stringify(entries));
		entities.journalEntries = entries.length;
	}

	// --- Currencies ---
	if (selection.currencies) {
		onProgress?.("Gathering currencies...");
		const currencies = await backend.listCurrencies();
		zipFiles["currencies.json"] = strToU8(JSON.stringify(currencies));
		entities.currencies = currencies.length;
	}

	// --- Exchange rates ---
	if (selection.exchangeRates) {
		onProgress?.("Gathering exchange rates...");
		const exchangeRates = await backend.listExchangeRates();
		zipFiles["exchange-rates.json"] = strToU8(JSON.stringify(exchangeRates));
		entities.exchangeRates = exchangeRates.length;
	}

	// --- Sources (etherscan / bitcoin / generic chains / CEX) ---
	if (selection.sources) {
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
			api_key: selection.apiKeys ? a.api_key : "***",
			api_secret: selection.apiKeys ? a.api_secret : "***",
			passphrase: selection.apiKeys ? a.passphrase : a.passphrase ? "***" : null,
		}));
		zipFiles["sources.json"] = strToU8(JSON.stringify(sources));
	}

	// --- Budgets & reconciliations ---
	if (selection.budgets) {
		onProgress?.("Gathering budgets...");
		const budgets = await backend.listBudgets();
		zipFiles["budgets.json"] = strToU8(JSON.stringify(budgets));
		entities.budgets = budgets.length;
	}
	if (selection.reconciliations) {
		const reconciliations = await backend.listReconciliations();
		zipFiles["reconciliations.json"] = strToU8(JSON.stringify(reconciliations));
		entities.reconciliations = reconciliations.length;
	}

	// --- Raw transactions (can be large) ---
	if (selection.rawTransactions) {
		onProgress?.("Gathering raw transactions...");
		const rawTransactions = await backend.queryRawTransactions("");
		zipFiles["raw-transactions.json"] = strToU8(JSON.stringify(rawTransactions));
		entities.rawTransactions = rawTransactions.length;
	}

	// --- Custom plugins ---
	if (selection.plugins) {
		onProgress?.("Gathering plugins...");
		try {
			const customPlugins = (await backend.listCustomPlugins()).map(p => ({
				id: p.id, name: p.name, version: p.version, description: p.description,
				source_code: p.source_code, enabled: p.enabled,
			}));
			if (customPlugins.length > 0) {
				const pluginsMeta = customPlugins.map(({ source_code: _, ...meta }) => meta);
				zipFiles["plugins.json"] = strToU8(JSON.stringify(pluginsMeta, null, 2));
				for (const p of customPlugins) {
					zipFiles[`plugins/${p.id}.js`] = strToU8(p.source_code);
				}
			}
			entities.plugins = customPlugins.length;
		} catch { /* optional — old schema may lack table */ }
	}

	// --- ML reference examples ---
	if (mlActive && selection.mlExamples) {
		onProgress?.("Gathering ML classification data...");
		try {
			const examplesByAccount = await buildHistoricalExamples(backend);
			const tagExamples = await buildHistoricalTagExamples(backend);
			const storedReferences = (await backend.listMlReferenceExamples()).map(r => ({
				id: r.id,
				description: r.description,
				account_path: r.account_path,
				tags: r.tags,
				source: r.source,
				created_at: r.created_at,
			}));
			const payload: MlReferencePayload = {
				version: 1,
				examplesByAccount,
				tagExamples,
				storedReferences,
			};
			zipFiles["ml-reference.json"] = strToU8(JSON.stringify(payload));
			entities.mlReferenceExamples = examplesByAccount.reduce(
				(s, e) => s + e.descriptions.length,
				0,
			);
		} catch { /* backend without ML reference support — skip */ }
	}

	// --- Settings (with selective stripping for ML fields) ---
	// Emit settings.json if any settings-bearing toggle is on.
	const emitSettings =
		selection.settings ||
		(mlActive && (selection.mlRules || selection.mlSettings));
	if (emitSettings) {
		const raw = loadSettings();
		const settingsExport: Partial<AppSettings> = selection.settings ? { ...raw } : {};

		if (selection.settings) {
			// Strip ML-owned keys when their toggles are off.
			if (!(mlActive && selection.mlRules)) {
				delete settingsExport[ML_RULES_KEY];
			}
			if (!(mlActive && selection.mlSettings)) {
				for (const k of ML_SETTINGS_KEYS) delete settingsExport[k];
			}
			// Strip API keys unless opted in.
			if (!selection.apiKeys) {
				for (const k of API_KEY_FIELDS) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					if ((settingsExport as any)[k]) (settingsExport as any)[k] = "***";
				}
			}
		} else {
			// Settings master toggle off — carry only ML keys the user selected.
			if (mlActive && selection.mlRules && raw[ML_RULES_KEY] !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(settingsExport as any)[ML_RULES_KEY] = raw[ML_RULES_KEY];
			}
			if (mlActive && selection.mlSettings) {
				for (const k of ML_SETTINGS_KEYS) {
					if (raw[k] !== undefined) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(settingsExport as any)[k] = raw[k];
					}
				}
			}
		}
		zipFiles["settings.json"] = strToU8(JSON.stringify(settingsExport, null, 2));
	}

	// --- Manifest (always included) ---
	const manifest: ExportManifest = {
		exportVersion: EXPORT_VERSION,
		schemaVersion: 39,
		exportedAt: new Date().toISOString(),
		appVersion,
		entities,
	};
	zipFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

	onProgress?.("Building archive...");
	const zipBytes = zipSync(zipFiles);

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
