import { v7 as uuidv7 } from "uuid";
import Decimal from "decimal.js-light";
import type { Backend } from "../backend.js";
import type { Account, JournalEntry, LineItem } from "../types/index.js";
import type { MatchCandidate, MergeOptions, MergeResult } from "./types.js";
import { inferAccountType } from "../browser-etherscan.js";

/**
 * Merge a single matched pair: void both originals, post a new consolidated entry.
 */
export async function mergeMatchedPair(
	backend: Backend,
	match: MatchCandidate,
	accountMap: Map<string, Account>,
	description?: string,
): Promise<{ entryId: string; warning?: string }> {
	const { movementA, movementB } = match;

	// Use earlier date
	const date = movementA.entry.date <= movementB.entry.date
		? movementA.entry.date
		: movementB.entry.date;

	// Build description
	const desc = description ?? `Transfer: ${movementA.realAccountName} \u2192 ${movementB.realAccountName}`;

	// Build source
	const sourceA = movementA.entry.source;
	const sourceB = movementB.entry.source;
	const source = `matched:${sourceA}+${sourceB}`;

	// Collect line items for the merged entry
	const newItems: Array<{ accountId: string; currency: string; amount: Decimal }> = [];

	// Real account items from both movements
	newItems.push({
		accountId: movementA.realAccountId,
		currency: movementA.currency,
		amount: new Decimal(movementA.amount),
	});
	newItems.push({
		accountId: movementB.realAccountId,
		currency: movementB.currency,
		amount: new Decimal(movementB.amount),
	});

	// Fee items from both
	for (const fee of [...movementA.feeItems, ...movementB.feeItems]) {
		newItems.push({
			accountId: fee.account_id,
			currency: fee.currency,
			amount: new Decimal(fee.amount),
		});
	}

	// Other (non-suspense, non-fee, non-primary-real) items from both
	for (const other of [...movementA.otherItems, ...movementB.otherItems]) {
		newItems.push({
			accountId: other.account_id,
			currency: other.currency,
			amount: new Decimal(other.amount),
		});
	}

	// Check balance per currency — if imbalanced, add a transfer fee line
	let warning: string | undefined;
	const balanceByCurrency = new Map<string, Decimal>();
	for (const item of newItems) {
		const prev = balanceByCurrency.get(item.currency) ?? new Decimal(0);
		balanceByCurrency.set(item.currency, prev.plus(item.amount));
	}

	for (const [currency, balance] of balanceByCurrency) {
		if (!balance.isZero()) {
			// Create or find a transfer fees account
			const feeAccountName = "Expenses:Fees:Transfer";
			let feeAccount = accountMap.get(feeAccountName);
			if (!feeAccount) {
				feeAccount = await ensureAccountHelper(backend, accountMap, feeAccountName, date);
			}
			newItems.push({
				accountId: feeAccount.id,
				currency,
				amount: balance.neg(),
			});
			warning = `Imbalance of ${balance.toFixed()} ${currency} booked to ${feeAccountName}`;
		}
	}

	// Void both originals
	await backend.voidJournalEntry(movementA.entry.id);
	await backend.voidJournalEntry(movementB.entry.id);

	// Post merged entry
	const entryId = uuidv7();
	const newEntry: JournalEntry = {
		id: entryId,
		date,
		description: desc,
		status: "confirmed",
		source,
		voided_by: null,
		created_at: date,
	};

	const lineItems: LineItem[] = newItems.map((item) => ({
		id: uuidv7(),
		journal_entry_id: entryId,
		account_id: item.accountId,
		currency: item.currency,
		amount: item.amount.toFixed(),
		lot_id: null,
	}));

	await backend.postJournalEntry(newEntry, lineItems);

	// Merge metadata from both originals
	const metaA = await backend.getMetadata(movementA.entry.id);
	const metaB = await backend.getMetadata(movementB.entry.id);
	const mergedMeta: Record<string, string> = {
		...metaA,
		...metaB,
		cross_match_linked: "true",
		cross_match_source_a: movementA.entry.source,
		cross_match_source_b: movementB.entry.source,
	};
	await backend.setMetadata(entryId, mergedMeta);

	return { entryId, warning };
}

/**
 * Merge all provided matches, with progress reporting and abort support.
 */
export async function mergeAllMatches(
	backend: Backend,
	matches: MatchCandidate[],
	accountMap: Map<string, Account>,
	options?: MergeOptions,
): Promise<MergeResult> {
	const result: MergeResult = {
		matched: 0,
		skipped: 0,
		warnings: [],
		mergedEntryIds: [],
	};

	if (options?.dryRun) {
		result.matched = matches.length;
		return result;
	}

	const total = matches.length;
	for (let i = 0; i < total; i++) {
		if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		options?.onProgress?.({ current: i, total, message: `Merging ${i + 1} of ${total}...` });

		try {
			backend.beginTransaction?.();
			const { entryId, warning } = await mergeMatchedPair(backend, matches[i], accountMap);
			backend.commitTransaction?.();
			result.mergedEntryIds.push(entryId);
			result.matched++;
			if (warning) result.warnings.push(warning);
		} catch (e) {
			backend.rollbackTransaction?.();
			const msg = e instanceof Error ? e.message : String(e);
			result.warnings.push(`Failed to merge: ${msg}`);
			result.skipped++;
		}
	}

	options?.onProgress?.({ current: total, total, message: "Done" });
	return result;
}

/** Ensure an account exists with all parent accounts. */
async function ensureAccountHelper(
	backend: Backend,
	accountMap: Map<string, Account>,
	fullName: string,
	date: string,
): Promise<Account> {
	const existing = accountMap.get(fullName);
	if (existing) return existing;

	const accountType = inferAccountType(fullName);
	const parts = fullName.split(":");
	let parentId: string | null = null;

	for (let depth = 1; depth < parts.length; depth++) {
		const ancestorName = parts.slice(0, depth).join(":");
		const existingAncestor = accountMap.get(ancestorName);
		if (existingAncestor) {
			parentId = existingAncestor.id;
		} else {
			const id = uuidv7();
			const acc: Account = {
				id,
				parent_id: parentId,
				account_type: accountType,
				name: parts[depth - 1],
				full_name: ancestorName,
				allowed_currencies: [],
				is_postable: true,
				is_archived: false,
				created_at: date,
			};
			await backend.createAccount(acc);
			accountMap.set(ancestorName, acc);
			parentId = id;
		}
	}

	const id = uuidv7();
	const acc: Account = {
		id,
		parent_id: parentId,
		account_type: accountType,
		name: parts[parts.length - 1],
		full_name: fullName,
		allowed_currencies: [],
		is_postable: true,
		is_archived: false,
		created_at: date,
	};
	await backend.createAccount(acc);
	accountMap.set(fullName, acc);
	return acc;
}
