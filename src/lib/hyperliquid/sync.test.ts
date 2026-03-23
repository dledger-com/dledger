import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HlFill, HlFundingDelta, HlLedgerUpdate } from "./types.js";

// Mock the API module
vi.mock("./api.js", () => ({
	fetchUserFills: vi.fn().mockResolvedValue([]),
	fetchUserFunding: vi.fn().mockResolvedValue([]),
	fetchUserLedgerUpdates: vi.fn().mockResolvedValue([]),
}));

// Mock invalidation
vi.mock("../data/invalidation.js", () => ({
	invalidate: vi.fn(),
}));

import { fetchUserFills, fetchUserFunding, fetchUserLedgerUpdates } from "./api.js";
import { syncHyperliquidAccount } from "./sync.js";
import { SqlJsBackend } from "../sql-js-backend.js";

const mockedFills = vi.mocked(fetchUserFills);
const mockedFunding = vi.mocked(fetchUserFunding);
const mockedLedger = vi.mocked(fetchUserLedgerUpdates);

describe("syncHyperliquidAccount", () => {
	let backend: SqlJsBackend;
	const account = {
		id: "test-hl-1",
		address: "0x1234567890abcdef1234567890abcdef12345678",
		label: "Test HL",
		last_sync_time: null,
		last_sync: null,
		created_at: "2024-01-01T00:00:00Z",
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		backend = await SqlJsBackend.createInMemory();
	});

	it("returns zeros when no activity", async () => {
		mockedFills.mockResolvedValue([]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.fills_imported).toBe(0);
		expect(result.funding_imported).toBe(0);
		expect(result.ledger_imported).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("imports a perp fill with realized PnL", async () => {
		const fill: HlFill = {
			coin: "BTC", px: "50000", sz: "0.1", side: "A", time: 1700000000000,
			startPosition: "0.1", dir: "Close Long", closedPnl: "500.00",
			hash: "0xfill1", oid: 1, crossed: true, fee: "1.50", tid: 100, feeToken: "USDC",
		};
		mockedFills.mockResolvedValue([fill]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.fills_imported).toBe(1);

		// Check journal entries were created
		const entries = await backend.queryJournalEntries({});
		expect(entries.length).toBeGreaterThanOrEqual(1);

		// Should have PnL and fee entries
		const allLineItems = entries.flatMap(([, items]) => items);
		const usdcItems = allLineItems.filter(li => li.currency === "USDC");
		expect(usdcItems.length).toBeGreaterThan(0);
	});

	it("skips perp fill with no PnL and no fee", async () => {
		const fill: HlFill = {
			coin: "ETH", px: "3000", sz: "1", side: "B", time: 1700000000000,
			startPosition: "0", dir: "Open Long", closedPnl: "0",
			hash: "0xopen1", oid: 2, crossed: false, fee: "0", tid: 200, feeToken: "USDC",
		};
		mockedFills.mockResolvedValue([fill]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.fills_imported).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("aggregates funding by day and coin", async () => {
		const funding: HlFundingDelta[] = [
			{
				coin: "BTC", fundingRate: "0.0001", szi: "0.5", type: "funding",
				usdc: "0.10", hash: "0xf1", time: 1700000000000,
			},
			{
				coin: "BTC", fundingRate: "0.0001", szi: "0.5", type: "funding",
				usdc: "0.15", hash: "0xf2", time: 1700003600000, // same day (1 hour later)
			},
			{
				coin: "ETH", fundingRate: "-0.0002", szi: "5", type: "funding",
				usdc: "-0.50", hash: "0xf3", time: 1700000000000,
			},
		];
		mockedFills.mockResolvedValue([]);
		mockedFunding.mockResolvedValue(funding);
		mockedLedger.mockResolvedValue([]);

		const result = await syncHyperliquidAccount(backend, account);

		// BTC funding aggregated to 1 entry, ETH funding = 1 entry
		expect(result.funding_imported).toBe(2);
	});

	it("imports deposit ledger update", async () => {
		const deposit: HlLedgerUpdate = {
			time: 1700000000000,
			hash: "0xdep1",
			delta: { type: "deposit", usdc: "10000" },
		};
		mockedFills.mockResolvedValue([]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([deposit]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.ledger_imported).toBe(1);

		const entries = await backend.queryJournalEntries({});
		const depositEntry = entries.find(([e]) => e.source.includes("ledger"));
		expect(depositEntry).toBeDefined();
	});

	it("imports withdrawal with fee", async () => {
		const withdrawal: HlLedgerUpdate = {
			time: 1700000000000,
			hash: "0xwd1",
			delta: { type: "withdraw", usdc: "5000", nonce: 1, fee: "1" },
		};
		mockedFills.mockResolvedValue([]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([withdrawal]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.ledger_imported).toBe(1);
	});

	it("skips internal transfers", async () => {
		const transfer: HlLedgerUpdate = {
			time: 1700000000000,
			hash: "0xtx1",
			delta: {
				type: "internalTransfer", usdc: "100",
				user: "0xaaa", destination: "0xbbb", fee: "0",
			},
		};
		mockedFills.mockResolvedValue([]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([transfer]);

		const result = await syncHyperliquidAccount(backend, account);

		expect(result.ledger_imported).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("deduplicates on re-sync", async () => {
		const fill: HlFill = {
			coin: "BTC", px: "50000", sz: "0.1", side: "A", time: 1700000000000,
			startPosition: "0.1", dir: "Close Long", closedPnl: "100",
			hash: "0xdedup1", oid: 1, crossed: true, fee: "0.5", tid: 100, feeToken: "USDC",
		};
		mockedFills.mockResolvedValue([fill]);
		mockedFunding.mockResolvedValue([]);
		mockedLedger.mockResolvedValue([]);

		// First sync
		const r1 = await syncHyperliquidAccount(backend, account);
		expect(r1.fills_imported).toBe(1);

		// Second sync (same data)
		const r2 = await syncHyperliquidAccount(backend, account);
		expect(r2.fills_imported).toBe(0);
		expect(r2.skipped).toBe(1);
	});
});
