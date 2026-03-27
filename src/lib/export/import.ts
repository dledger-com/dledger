// Import a .dledger file: decrypt → extract → validate → restore.

import { unzipSync, strFromU8 } from "fflate";
import { v7 as uuidv7 } from "uuid";
import type { Backend } from "../backend.js";
import type { Account, Currency, JournalEntry, LineItem, ExchangeRate, Budget } from "../types/index.js";
import { saveToStorage, type AppSettings } from "../data/settings.svelte.js";
import { decrypt } from "./encrypt.js";
import { deserializeExport } from "./format.js";
import { EXPORT_VERSION, type ExportManifest, type ImportMode, type ImportProgress, type ImportResult } from "./types.js";

/**
 * Import a .dledger file into the app.
 */
export async function importData(
	backend: Backend,
	fileBytes: Uint8Array,
	options: {
		passphrase?: string;
		mode?: ImportMode;
		importSettings?: boolean;
	} = {},
	onProgress?: (progress: ImportProgress) => void,
): Promise<ImportResult> {
	const mode = options.mode ?? "replace";
	const result: ImportResult = {
		accounts_imported: 0,
		entries_imported: 0,
		currencies_imported: 0,
		rates_imported: 0,
		plugins_imported: 0,
		skipped: 0,
		warnings: [],
	};

	// 1. Deserialize header
	onProgress?.({ phase: "decrypting", current: 0, total: 1 });
	const { header, payload } = deserializeExport(fileBytes);

	if (header.version > EXPORT_VERSION) {
		throw new Error(`Export version ${header.version} is newer than supported (${EXPORT_VERSION}). Please update the app.`);
	}

	// 2. Decrypt if needed
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

	// 3. Extract ZIP
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

	// 4. Validate
	onProgress?.({ phase: "validating", current: 0, total: 1 });
	if (manifest.exportVersion > EXPORT_VERSION) {
		throw new Error(`Export version ${manifest.exportVersion} is not supported. Please update the app.`);
	}

	// Parse all data files
	const accounts: Account[] = files["accounts.json"] ? JSON.parse(strFromU8(files["accounts.json"])) : [];
	const currencies: Currency[] = files["currencies.json"] ? JSON.parse(strFromU8(files["currencies.json"])) : [];
	const exchangeRates: ExchangeRate[] = files["exchange-rates.json"] ? JSON.parse(strFromU8(files["exchange-rates.json"])) : [];
	const budgets: Budget[] = files["budgets.json"] ? JSON.parse(strFromU8(files["budgets.json"])) : [];
	const settings: AppSettings | undefined = files["settings.json"] ? JSON.parse(strFromU8(files["settings.json"])) : undefined;

	// Journal entries with embedded line items + metadata
	const journalRaw: Array<JournalEntry & { lineItems: LineItem[]; metadata?: Record<string, string> | null; links?: string[] | null }> =
		files["journal.json"] ? JSON.parse(strFromU8(files["journal.json"])) : [];

	onProgress?.({ phase: "validating", current: 1, total: 1 });

	// 5. Import
	const totalEntities = accounts.length + currencies.length + journalRaw.length + exchangeRates.length;
	let processed = 0;

	if (mode === "replace") {
		onProgress?.({ phase: "importing", current: 0, total: totalEntities, entity: "clearing" });
		await backend.clearAllData();

		// Import settings
		if (options.importSettings && settings) {
			saveToStorage(settings);
		}
	}

	// Build dedup indexes for merge-skip mode
	let existingCurrencyKeys: Set<string> | null = null;
	let existingAccountPaths: Set<string> | null = null;
	let existingEntryIds: Set<string> | null = null;
	let existingEntrySources: Set<string> | null = null;

	if (mode === "merge-skip") {
		onProgress?.({ phase: "importing", current: 0, total: totalEntities, entity: "building dedup index" });
		existingCurrencyKeys = new Set((await backend.listCurrencies()).map(c => `${c.code}\0${c.asset_type}\0${c.param}`));
		existingAccountPaths = new Set((await backend.listAccounts()).map(a => a.full_name));
		const allEntries = await backend.queryJournalEntries({});
		existingEntryIds = new Set(allEntries.map(([e]) => e.id));
		existingEntrySources = new Set(allEntries.map(([e]) => e.source).filter(Boolean));
	}

	// Currencies first (other entities reference them)
	onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "currencies" });
	for (const currency of currencies) {
		const key = `${currency.code}\0${currency.asset_type}\0${currency.param}`;
		if (existingCurrencyKeys?.has(key)) { result.skipped++; processed++; continue; }
		try {
			await backend.createCurrency(currency);
			result.currencies_imported++;
		} catch { result.skipped++; }
		processed++;
		if (processed % 50 === 0) onProgress?.({ phase: "importing", current: processed, total: totalEntities, entity: "currencies" });
	}

	// Accounts (order by depth to ensure parents exist before children)
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
		// Dedup by ID or source key
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

	// Exchange rates (recordExchangeRate already handles priority-based dedup internally)
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
	for (const budget of budgets) {
		try { await backend.createBudget(budget); } catch { result.skipped++; }
	}

	// Source accounts (from sources.json)
	if (files["sources.json"]) {
		try {
			const sources = JSON.parse(strFromU8(files["sources.json"]));
			for (const acc of sources.etherscan ?? []) { try { await backend.addEtherscanAccount(acc.address, acc.chain_id, acc.label); } catch { /* skip */ } }
			for (const acc of sources.bitcoin ?? []) { try { await backend.addBitcoinAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.solana ?? []) { try { await backend.addSolanaAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.hyperliquid ?? []) { try { await backend.addHyperliquidAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.sui ?? []) { try { await backend.addSuiAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.aptos ?? []) { try { await backend.addAptosAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.ton ?? []) { try { await backend.addTonAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.tezos ?? []) { try { await backend.addTezosAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.cosmos ?? []) { try { await backend.addCosmosAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.polkadot ?? []) { try { await backend.addPolkadotAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.doge ?? []) { try { await backend.addDogeAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.ltc ?? []) { try { await backend.addLtcAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.bch ?? []) { try { await backend.addBchAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.dash ?? []) { try { await backend.addDashAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.bsv ?? []) { try { await backend.addBsvAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.xec ?? []) { try { await backend.addXecAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.grs ?? []) { try { await backend.addGrsAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.xrp ?? []) { try { await backend.addXrpAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.tron ?? []) { try { await backend.addTronAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.stellar ?? []) { try { await backend.addStellarAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.bittensor ?? []) { try { await backend.addBittensorAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.hedera ?? []) { try { await backend.addHederaAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.near ?? []) { try { await backend.addNearAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.algorand ?? []) { try { await backend.addAlgorandAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.kaspa ?? []) { try { await backend.addKaspaAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.zcash ?? []) { try { await backend.addZcashAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.stacks ?? []) { try { await backend.addStacksAccount(acc); } catch { /* skip */ } }
			for (const acc of sources.cex ?? []) { try { await backend.addExchangeAccount(acc); } catch { /* skip */ } }
		} catch (e) {
			result.warnings.push(`sources: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Custom plugins
	if (files["plugins.json"]) {
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

	onProgress?.({ phase: "importing", current: totalEntities, total: totalEntities });
	return result;
}
