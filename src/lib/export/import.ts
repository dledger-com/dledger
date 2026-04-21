// Import a .dledger file: decrypt → extract → validate → restore.

import { unzipSync, strFromU8 } from "fflate";
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, Currency, JournalEntry, LineItem, ExchangeRate, Budget, MlReferenceExample } from "../types/index.js";
import { loadSettings, saveToStorage, type AppSettings } from "../data/settings.svelte.js";
import { decrypt } from "./encrypt.js";
import { deserializeExport } from "./format.js";
import {
	EXPORT_VERSION,
	defaultImportSelection,
	type ExportManifest,
	type ImportMode,
	type ImportOptions,
	type ImportProgress,
	type ImportResult,
	type ImportSelection,
	type MlReferencePayload,
} from "./types.js";

const ML_RULES_KEY: keyof AppSettings = "csvCategorizationRules";
const ML_SETTINGS_KEYS: Array<keyof AppSettings> = [
	"mlClassificationEnabled",
	"mlConfidenceThreshold",
];

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
 * Import a .dledger file into the app.
 *
 * Selection-gated reads: a category only applies when both (a) the user
 * opted-in via `selection` and (b) the archive actually carries that file.
 * Older v1 archives naturally have fewer artifacts.
 */
export async function importData(
	backend: Backend,
	fileBytes: Uint8Array,
	options: ImportOptions = {},
	onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
	const mode: ImportMode = options.mode ?? "replace";
	const selection: ImportSelection = options.selection ?? defaultImportSelection();
	const result: ImportResult = {
		accounts_imported: 0,
		entries_imported: 0,
		currencies_imported: 0,
		rates_imported: 0,
		plugins_imported: 0,
		ml_references_imported: 0,
		skipped: 0,
		warnings: [],
	};

	onProgress?.({ phase: "decrypting", current: 0, total: 1 });
	const { header, payload } = deserializeExport(fileBytes);

	if (header.version > EXPORT_VERSION) {
		throw new Error(`Export version ${header.version} is newer than supported (${EXPORT_VERSION}). Please update the app.`);
	}

	let zipBytes: Uint8Array;
	if (header.encrypted) {
		if (!options.passphrase) {
			throw new Error("This export is encrypted. Please provide the passphrase.");
		}
		if (!header.encryption) {
			throw new Error("Encrypted export missing encryption parameters.");
		}
		try {
			zipBytes = await decrypt(
				payload,
				options.passphrase,
				header.encryption.saltBase64,
				header.encryption.ivBase64,
			);
		} catch {
			throw new Error("Decryption failed. Wrong passphrase?");
		}
	} else {
		zipBytes = payload;
	}
	onProgress?.({ phase: "decrypting", current: 1, total: 1 });

	onProgress?.({ phase: "extracting", current: 0, total: 1 });
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(zipBytes);
	} catch {
		throw new Error("Failed to extract archive. File may be corrupted.");
	}

	if (!files["manifest.json"]) {
		throw new Error("Invalid export: missing manifest.json");
	}

	const manifest: ExportManifest = JSON.parse(strFromU8(files["manifest.json"]));
	onProgress?.({ phase: "extracting", current: 1, total: 1 });

	onProgress?.({ phase: "validating", current: 0, total: 1 });
	if (manifest.exportVersion > EXPORT_VERSION) {
		throw new Error(`Export version ${manifest.exportVersion} is not supported. Please update the app.`);
	}

	// --- Parse artifacts the user opted into (and that exist in the archive) ---
	const accounts: Account[] =
		selection.accounts && files["accounts.json"]
			? JSON.parse(strFromU8(files["accounts.json"]))
			: [];
	const currencies: Currency[] =
		selection.currencies && files["currencies.json"]
			? JSON.parse(strFromU8(files["currencies.json"]))
			: [];
	const exchangeRates: ExchangeRate[] =
		selection.exchangeRates && files["exchange-rates.json"]
			? JSON.parse(strFromU8(files["exchange-rates.json"]))
			: [];
	const budgets: Budget[] =
		selection.budgets && files["budgets.json"]
			? JSON.parse(strFromU8(files["budgets.json"]))
			: [];
	const settingsFromFile: Partial<AppSettings> | undefined = files["settings.json"]
		? JSON.parse(strFromU8(files["settings.json"]))
		: undefined;
	const journalRaw: Array<JournalEntry & { lineItems: LineItem[]; metadata?: Record<string, string> | null; links?: string[] | null }> =
		selection.journal && files["journal.json"]
			? JSON.parse(strFromU8(files["journal.json"]))
			: [];

	onProgress?.({ phase: "validating", current: 1, total: 1 });

	const totalEntities = accounts.length + currencies.length + journalRaw.length + exchangeRates.length;
	let processed = 0;

	if (mode === "replace") {
		onProgress?.({ phase: "importing", current: 0, total: totalEntities, entity: "clearing" });
		await backend.clearAllData();
	}

	// --- Settings merge (honours granular flags even when master settings toggle is off) ---
	if (settingsFromFile) {
		const current = loadSettings();
		const merged: AppSettings = { ...current };

		if (selection.settings) {
			// Apply all non-ML, non-apikey-redacted fields from the file.
			for (const key of Object.keys(settingsFromFile) as Array<keyof AppSettings>) {
				if (key === ML_RULES_KEY && !(selection.mlClassification && selection.mlRules)) continue;
				if (ML_SETTINGS_KEYS.includes(key) && !(selection.mlClassification && selection.mlSettings)) continue;
				if (API_KEY_FIELDS.includes(key) && !selection.apiKeys) continue;
				if (API_KEY_FIELDS.includes(key) && settingsFromFile[key] === "***") continue;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(merged as any)[key] = settingsFromFile[key];
			}
		} else {
			// Master settings off: still apply ML-specific fields if opted in.
			if (selection.mlClassification && selection.mlRules && settingsFromFile[ML_RULES_KEY] !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(merged as any)[ML_RULES_KEY] = settingsFromFile[ML_RULES_KEY];
			}
			if (selection.mlClassification && selection.mlSettings) {
				for (const k of ML_SETTINGS_KEYS) {
					if (settingsFromFile[k] !== undefined) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(merged as any)[k] = settingsFromFile[k];
					}
				}
			}
		}

		saveToStorage(merged);
	}

	// --- Build dedup indexes for merge-skip mode ---
	let existingCurrencyKeys: Set<string> | null = null;
	let existingAccountPaths: Set<string> | null = null;
	let existingEntryIds: Set<string> | null = null;
	let existingEntrySources: Set<string> | null = null;

	if (mode === "merge-skip") {
		onProgress?.({ phase: "importing", current: 0, total: totalEntities, entity: "building dedup index" });
		existingCurrencyKeys = new Set((await backend.listCurrencies()).map(c => c.code));
		existingAccountPaths = new Set((await backend.listAccounts()).map(a => a.full_name));
		const allEntries = await backend.queryJournalEntries({});
		existingEntryIds = new Set(allEntries.map(([e]) => e.id));
		existingEntrySources = new Set(allEntries.map(([e]) => e.source).filter(Boolean));
	}

	// Currencies first (other entities reference them)
	onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "currencies" });
	for (const currency of currencies) {
		if (existingCurrencyKeys?.has(currency.code)) { result.skipped++; processed++; continue; }
		try {
			await backend.createCurrency(currency);
			result.currencies_imported++;
		} catch { result.skipped++; }
		processed++;
		if (processed % 50 === 0) onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "currencies" });
	}

	// Accounts (order by depth so parents exist before children)
	onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "accounts" });
	const sortedAccounts = [...accounts].sort((a, b) => {
		const depthA = a.full_name.split(":").length;
		const depthB = b.full_name.split(":").length;
		return depthA - depthB;
	});

	for (const account of sortedAccounts) {
		if (existingAccountPaths?.has(account.full_name)) { result.skipped++; processed++; continue; }
		try {
			await backend.createAccount(account);
			result.accounts_imported++;
		} catch { result.skipped++; }
		processed++;
		if (processed % 50 === 0) onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "accounts" });
	}

	// Journal entries with line items
	onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "journal" });
	for (const raw of journalRaw) {
		if (existingEntryIds?.has(raw.id)) { result.skipped++; processed++; continue; }
		if (raw.source && existingEntrySources?.has(raw.source)) { result.skipped++; processed++; continue; }

		const entry: JournalEntry = {
			id: raw.id,
			date: raw.date,
			description: raw.description,
			description_data: raw.description_data,
			status: raw.status,
			source: raw.source,
			voided_by: raw.voided_by,
			created_at: raw.created_at,
		};

		try {
			await backend.postJournalEntry(entry, raw.lineItems);
			if (raw.metadata && Object.keys(raw.metadata).length > 0) {
				await backend.setMetadata(entry.id, raw.metadata);
			}
			if (raw.links && raw.links.length > 0) {
				await backend.setEntryLinks(entry.id, raw.links);
			}
			result.entries_imported++;
		} catch { result.skipped++; }
		processed++;
		if (processed % 100 === 0) onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "journal" });
	}

	// Exchange rates
	onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "rates" });
	for (const rate of exchangeRates) {
		try {
			await backend.recordExchangeRate(rate);
			result.rates_imported++;
		} catch { result.skipped++; }
		processed++;
		if (processed % 500 === 0) onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "rates" });
	}

	// Budgets
	if (selection.budgets) {
		for (const budget of budgets) {
			try { await backend.createBudget(budget); } catch { result.skipped++; }
		}
	}

	// Source accounts (from sources.json)
	if (selection.sources && files["sources.json"]) {
		try {
			const sources = JSON.parse(strFromU8(files["sources.json"]));
			for (const acc of sources.etherscan ?? []) { try { await backend.addEtherscanAccount(acc.address, acc.chain_id, acc.label); } catch { /* skip */ } }
			for (const acc of sources.bitcoin ?? []) { try { await backend.addBitcoinAccount(acc); } catch { /* skip */ } }
			const genericChains = [
				"solana", "hyperliquid", "sui", "aptos", "ton", "tezos", "cosmos", "polkadot",
				"doge", "ltc", "bch", "dash", "bsv", "xec", "grs",
				"xrp", "tron", "stellar", "bittensor", "hedera", "near", "algorand", "kaspa", "zcash", "stacks",
				"cardano", "monero", "bitshares",
			];
			for (const chain of genericChains) {
				for (const acc of sources[chain] ?? []) {
					try { await backend.addBlockchainAccount({ id: acc.id, chain, address: acc.address, label: acc.label, created_at: acc.created_at, extra: acc.extra ?? null }); } catch { /* skip */ }
				}
			}
			for (const acc of sources.cex ?? []) { try { await backend.addExchangeAccount(acc); } catch { /* skip */ } }
		} catch (e) {
			result.warnings.push(`sources: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Raw transactions
	if (selection.rawTransactions && files["raw-transactions.json"]) {
		try {
			const raw: Array<{ source: string; data: string }> = JSON.parse(strFromU8(files["raw-transactions.json"]));
			for (const r of raw) {
				try { await backend.storeRawTransaction(r.source, r.data); } catch { /* skip */ }
			}
		} catch (e) {
			result.warnings.push(`raw-transactions: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Custom plugins
	if (selection.plugins && files["plugins.json"]) {
		try {
			const pluginsMeta: Array<{ id: string; name: string; version: string; description: string; enabled: boolean }> =
				JSON.parse(strFromU8(files["plugins.json"]));
			for (const meta of pluginsMeta) {
				const sourceFile = files[`plugins/${meta.id}.js`];
				if (!sourceFile) continue;
				try {
					await backend.saveCustomPlugin({
						id: meta.id,
						name: meta.name,
						version: meta.version,
						description: meta.description,
						source_code: strFromU8(sourceFile),
						enabled: meta.enabled,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					});
					result.plugins_imported++;
				} catch { result.skipped++; }
			}
		} catch (e) {
			result.warnings.push(`plugins: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ML reference examples
	if (selection.mlClassification && selection.mlExamples && files["ml-reference.json"]) {
		try {
			const mlPayload: MlReferencePayload = JSON.parse(strFromU8(files["ml-reference.json"]));
			const nowIso = new Date().toISOString();

			// Index descriptions → primary account, for tag-example fallback.
			const descToAccount = new Map<string, string>();
			for (const row of mlPayload.examplesByAccount) {
				for (const desc of row.descriptions) {
					if (!descToAccount.has(desc)) descToAccount.set(desc, row.account);
				}
			}

			const tagByDesc = new Map<string, string[]>();
			for (const row of mlPayload.tagExamples) {
				if (row.tags && row.tags.length > 0) tagByDesc.set(row.description, row.tags);
			}

			const toUpsert: MlReferenceExample[] = [];

			for (const row of mlPayload.examplesByAccount) {
				for (const desc of row.descriptions) {
					toUpsert.push({
						id: uuidv7(),
						description: desc,
						account_path: row.account,
						tags: tagByDesc.get(desc) ?? null,
						source: "imported",
						created_at: nowIso,
					});
				}
			}

			// Tags for descriptions not tied to any account in examplesByAccount → skip + warn.
			for (const [desc] of tagByDesc) {
				if (!descToAccount.has(desc)) {
					result.warnings.push(`ml-reference: no account for tagged description "${desc}" — skipped`);
				}
			}

			// Verbatim user-created reference rows.
			for (const ref of mlPayload.storedReferences ?? []) {
				toUpsert.push({
					id: ref.id || uuidv7(),
					description: ref.description,
					account_path: ref.account_path,
					tags: ref.tags,
					source: ref.source ?? "user",
					created_at: ref.created_at || nowIso,
				});
			}

			if (toUpsert.length > 0) {
				await backend.upsertMlReferenceExamples(toUpsert);
				result.ml_references_imported = toUpsert.length;
			}
		} catch (e) {
			result.warnings.push(`ml-reference: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onProgress?.({ phase: "importing", current: totalEntities, total: totalEntities });
	return result;
}
