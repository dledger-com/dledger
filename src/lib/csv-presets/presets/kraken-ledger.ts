import type { CsvPreset, CsvRecord } from "../types.js";
import type { CsvImportOptions } from "$lib/utils/csv-import.js";
import { KRAKEN_ASSET_MAP } from "$lib/cex/kraken.js";

const REQUIRED_HEADERS = ["refid", "time", "type", "aclass", "asset", "amount", "fee", "balance"];

function normalizeAsset(raw: string): string {
  const trimmed = raw.trim();
  if (KRAKEN_ASSET_MAP[trimmed]) return KRAKEN_ASSET_MAP[trimmed];
  // Strip leading X or Z for 4-char codes
  if (trimmed.length === 4 && (trimmed.startsWith("X") || trimmed.startsWith("Z"))) {
    const base = trimmed.slice(1);
    if (KRAKEN_ASSET_MAP[base]) return KRAKEN_ASSET_MAP[base];
  }
  return trimmed;
}

export const krakenLedgerPreset: CsvPreset = {
  id: "kraken-ledger",
  name: "Kraken Ledger Export",
  description: "Kraken exchange ledger CSV export with refid, time, type, asset, amount, fee, balance.",
  suggestedMainAccount: "Assets:Exchanges:Kraken",

  detect(headers: string[]): number {
    const lower = headers.map((h) => h.trim().toLowerCase());
    const hasAll = REQUIRED_HEADERS.every((r) => lower.includes(r));
    return hasAll ? 90 : 0;
  },

  getDefaultMapping(headers: string[]): Partial<CsvImportOptions> {
    return {
      dateColumn: "time",
      descriptionColumn: "type",
      dateFormat: "ISO8601",
    };
  },

  transform(headers: string[], rows: string[][]): CsvRecord[] | null {
    const idx = (name: string) => headers.findIndex((h) => h.trim().toLowerCase() === name);
    const refidIdx = idx("refid");
    const timeIdx = idx("time");
    const typeIdx = idx("type");
    const assetIdx = idx("asset");
    const amountIdx = idx("amount");
    const feeIdx = idx("fee");

    if ([refidIdx, timeIdx, typeIdx, assetIdx, amountIdx, feeIdx].some((i) => i === -1)) {
      return null;
    }

    // Group by refid
    const groups = new Map<string, Array<{
      time: string; type: string; asset: string; amount: number; fee: number;
    }>>();

    for (const row of rows) {
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
      const refid = row[refidIdx]?.trim();
      if (!refid) continue;

      const rawTime = row[timeIdx]?.trim() ?? "";
      // Extract date from "YYYY-MM-DD HH:MM:SS" or ISO format
      const dateMatch = rawTime.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;

      const type = row[typeIdx]?.trim().toLowerCase() ?? "";
      const asset = normalizeAsset(row[assetIdx] ?? "");
      const amount = parseFloat(row[amountIdx] ?? "0");
      const fee = parseFloat(row[feeIdx] ?? "0");

      if (isNaN(amount)) continue;

      const arr = groups.get(refid) ?? [];
      arr.push({ time: dateMatch[1], type, asset, amount, fee: isNaN(fee) ? 0 : fee });
      groups.set(refid, arr);
    }

    const records: CsvRecord[] = [];

    for (const [refid, entries] of groups) {
      if (entries.length === 0) continue;
      const date = entries[0].time;
      const type = entries[0].type;

      if (type === "trade") {
        // Trade: multiple entries with same refid, different assets
        const lines: CsvRecord["lines"] = [];
        let description = "Kraken trade";
        const assets: string[] = [];

        for (const e of entries) {
          assets.push(e.asset);
          lines.push({
            account: `Assets:Exchanges:Kraken:${e.asset}`,
            currency: e.asset,
            amount: e.amount.toString(),
          });
          if (Math.abs(e.fee) > 0) {
            lines.push({
              account: `Expenses:Exchanges:Kraken:Fees`,
              currency: e.asset,
              amount: Math.abs(e.fee).toString(),
            });
            lines.push({
              account: `Assets:Exchanges:Kraken:${e.asset}`,
              currency: e.asset,
              amount: (-Math.abs(e.fee)).toString(),
            });
          }
        }

        description = `Kraken trade: ${assets.join("/")}`;

        // Add Equity:Trading legs to balance
        // Group by currency and sum
        const currencySums = new Map<string, number>();
        for (const l of lines) {
          const cur = currencySums.get(l.currency) ?? 0;
          currencySums.set(l.currency, cur + parseFloat(l.amount));
        }
        for (const [currency, sum] of currencySums) {
          if (Math.abs(sum) > 0.00000001) {
            lines.push({
              account: "Equity:Trading",
              currency,
              amount: (-sum).toString(),
            });
          }
        }

        records.push({
          date,
          description,
          lines,
          groupKey: refid,
          sourceKey: refid,
        });
      } else if (type === "deposit" || type === "withdrawal") {
        for (const e of entries) {
          const lines: CsvRecord["lines"] = [
            {
              account: `Assets:Exchanges:Kraken:${e.asset}`,
              currency: e.asset,
              amount: e.amount.toString(),
            },
            {
              account: "Equity:External",
              currency: e.asset,
              amount: (-e.amount).toString(),
            },
          ];

          if (Math.abs(e.fee) > 0) {
            lines.push({
              account: `Expenses:Exchanges:Kraken:Fees`,
              currency: e.asset,
              amount: Math.abs(e.fee).toString(),
            });
            lines.push({
              account: `Assets:Exchanges:Kraken:${e.asset}`,
              currency: e.asset,
              amount: (-Math.abs(e.fee)).toString(),
            });
          }

          records.push({
            date,
            description: `Kraken ${type}: ${e.asset}`,
            lines,
            sourceKey: refid,
          });
        }
      } else if (type === "staking") {
        for (const e of entries) {
          if (e.amount <= 0) continue;
          records.push({
            date,
            description: `Kraken staking reward: ${e.asset}`,
            lines: [
              {
                account: `Assets:Exchanges:Kraken:${e.asset}`,
                currency: e.asset,
                amount: e.amount.toString(),
              },
              {
                account: `Income:Exchanges:Kraken:Staking`,
                currency: e.asset,
                amount: (-e.amount).toString(),
              },
            ],
            sourceKey: refid,
          });
        }
      } else {
        // Other types: transfer, margin, etc.
        for (const e of entries) {
          records.push({
            date,
            description: `Kraken ${type}: ${e.asset}`,
            lines: [
              {
                account: `Assets:Exchanges:Kraken:${e.asset}`,
                currency: e.asset,
                amount: e.amount.toString(),
              },
              {
                account: "Equity:External",
                currency: e.asset,
                amount: (-e.amount).toString(),
              },
            ],
            sourceKey: refid,
          });
        }
      }
    }

    return records;
  },
};
