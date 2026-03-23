import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetRateLimiter } from "./api.js";

// Mock cexFetch
vi.mock("../cex/fetch.js", () => ({
	cexFetch: vi.fn(),
	abortableDelay: vi.fn().mockResolvedValue(undefined),
}));

import { cexFetch } from "../cex/fetch.js";
import {
	fetchUserFills,
	fetchUserFunding,
	fetchUserLedgerUpdates,
	fetchClearinghouseState,
	fetchSpotState,
} from "./api.js";

const mockedCexFetch = vi.mocked(cexFetch);

beforeEach(() => {
	vi.clearAllMocks();
	_resetRateLimiter();
});

describe("fetchUserFills", () => {
	it("returns fills from a single page", async () => {
		const fills = [
			{
				coin: "BTC", px: "50000", sz: "0.1", side: "B", time: 1700000000000,
				startPosition: "0", dir: "Open Long", closedPnl: "0", hash: "0xabc",
				oid: 1, crossed: true, fee: "0.5", tid: 100, feeToken: "USDC",
			},
		];
		mockedCexFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(fills) });

		const result = await fetchUserFills("0x1234567890abcdef1234567890abcdef12345678");

		expect(result).toHaveLength(1);
		expect(result[0].coin).toBe("BTC");
		expect(result[0].side).toBe("B");
		expect(mockedCexFetch).toHaveBeenCalledWith(
			"https://api.hyperliquid.xyz/info",
			"https://api.hyperliquid.xyz",
			"/api/hyperliquid",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("userFillsByTime"),
			}),
			undefined,
		);
	});

	it("paginates when page is full", async () => {
		const page1 = Array.from({ length: 2000 }, (_, i) => ({
			coin: "ETH", px: "3000", sz: "1", side: "A" as const, time: 1700000000000 + i,
			startPosition: "1", dir: "Close Long", closedPnl: "100", hash: `0x${i}`,
			oid: i, crossed: false, fee: "0.1", tid: i, feeToken: "USDC",
		}));
		const page2 = [
			{
				coin: "ETH", px: "3000", sz: "1", side: "A" as const, time: 1700000003000,
				startPosition: "0", dir: "Close Long", closedPnl: "50", hash: "0xlast",
				oid: 9999, crossed: false, fee: "0.1", tid: 9999, feeToken: "USDC",
			},
		];

		mockedCexFetch
			.mockResolvedValueOnce({ status: 200, body: JSON.stringify(page1) })
			.mockResolvedValueOnce({ status: 200, body: JSON.stringify(page2) });

		const result = await fetchUserFills("0x1234567890abcdef1234567890abcdef12345678");
		expect(result).toHaveLength(2001);
		expect(mockedCexFetch).toHaveBeenCalledTimes(2);
	});

	it("retries on 429", async () => {
		mockedCexFetch
			.mockResolvedValueOnce({ status: 429, body: "rate limited" })
			.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) });

		const result = await fetchUserFills("0x1234567890abcdef1234567890abcdef12345678");
		expect(result).toHaveLength(0);
		expect(mockedCexFetch).toHaveBeenCalledTimes(2);
	});

	it("throws on non-200 non-429 status", async () => {
		mockedCexFetch.mockResolvedValueOnce({ status: 500, body: "server error" });

		await expect(
			fetchUserFills("0x1234567890abcdef1234567890abcdef12345678"),
		).rejects.toThrow("Hyperliquid API error 500");
	});
});

describe("fetchUserFunding", () => {
	it("returns funding records", async () => {
		const funding = [
			{
				coin: "BTC", fundingRate: "0.0001", szi: "0.5", type: "funding" as const,
				usdc: "0.05", hash: "0xfund1", time: 1700000000000,
			},
		];
		mockedCexFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(funding) });

		const result = await fetchUserFunding("0x1234567890abcdef1234567890abcdef12345678");
		expect(result).toHaveLength(1);
		expect(result[0].usdc).toBe("0.05");
	});
});

describe("fetchUserLedgerUpdates", () => {
	it("returns ledger updates", async () => {
		const updates = [
			{ time: 1700000000000, hash: "0xdep1", delta: { type: "deposit", usdc: "1000" } },
			{ time: 1700000001000, hash: "0xwd1", delta: { type: "withdraw", usdc: "500", nonce: 1, fee: "1" } },
		];
		mockedCexFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(updates) });

		const result = await fetchUserLedgerUpdates("0x1234567890abcdef1234567890abcdef12345678");
		expect(result).toHaveLength(2);
		expect(result[0].delta.type).toBe("deposit");
		expect(result[1].delta.type).toBe("withdraw");
	});
});

describe("fetchClearinghouseState", () => {
	it("returns clearinghouse state", async () => {
		const state = {
			assetPositions: [],
			crossMarginSummary: { accountValue: "10000", totalNtlPos: "0", totalRawUsd: "10000", totalMarginUsed: "0" },
			crossMaintenanceMarginUsed: "0",
			withdrawable: "10000",
		};
		mockedCexFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(state) });

		const result = await fetchClearinghouseState("0x1234567890abcdef1234567890abcdef12345678");
		expect(result.withdrawable).toBe("10000");
	});
});

describe("fetchSpotState", () => {
	it("returns spot balances", async () => {
		const state = {
			balances: [
				{ coin: "USDC", hold: "0", total: "5000", token: 0, entryNtl: "5000" },
			],
		};
		mockedCexFetch.mockResolvedValueOnce({ status: 200, body: JSON.stringify(state) });

		const result = await fetchSpotState("0x1234567890abcdef1234567890abcdef12345678");
		expect(result.balances).toHaveLength(1);
		expect(result.balances[0].coin).toBe("USDC");
	});
});
