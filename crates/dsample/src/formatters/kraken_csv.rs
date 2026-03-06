use crate::formatters::Formatter;
use crate::model::SampleData;

pub struct KrakenCsvFormatter;

fn map_currency_code(code: &str) -> &str {
    match code {
        "BTC" => "XXBT",
        "ETH" => "XETH",
        "USD" => "ZUSD",
        "EUR" => "ZEUR",
        "GBP" => "ZGBP",
        "CAD" => "ZCAD",
        "JPY" => "ZJPY",
        "CHF" => "ZCHF",
        "AUD" => "ZAUD",
        other => other,
    }
}

fn classify_entry(description: &str) -> Option<&'static str> {
    let desc_lower = description.to_lowercase();
    if desc_lower.contains("trade") || desc_lower.contains("buy") || desc_lower.contains("sell") || desc_lower.contains("exchange") {
        Some("trade")
    } else if desc_lower.contains("deposit") || desc_lower.contains("receive") {
        Some("deposit")
    } else if desc_lower.contains("withdraw") || desc_lower.contains("send") {
        Some("withdrawal")
    } else if desc_lower.contains("stak") || desc_lower.contains("reward") {
        Some("staking")
    } else {
        None
    }
}

impl Formatter for KrakenCsvFormatter {
    fn format(&self, data: &SampleData, _seed: u64) -> String {
        let mut out = String::new();

        // CSV header
        out.push_str("\"txid\",\"refid\",\"time\",\"type\",\"subtype\",\"aclass\",\"asset\",\"amount\",\"fee\",\"balance\"\n");

        let mut row_index: u64 = 0;

        for (entry_idx, entry) in data.entries.iter().enumerate() {
            let entry_type = match classify_entry(&entry.description) {
                Some(t) => t,
                None => continue, // Skip non-exchange entries
            };

            // Generate time: base at 10:00:00 + offset from entry index
            let seconds_offset = (entry_idx as u64) % 86400;
            let hours = 10 + (seconds_offset / 3600);
            let minutes = (seconds_offset % 3600) / 60;
            let seconds = seconds_offset % 60;
            let time_str = format!(
                "{} {:02}:{:02}:{:02}",
                entry.date.format("%Y-%m-%d"),
                hours % 24,
                minutes,
                seconds
            );

            // Emit one row per posting (excluding fee-like postings for trades)
            for posting in &entry.postings {
                row_index += 1;

                let txid = format!("TXID{:06}", row_index);
                let refid = format!("REFID{:06}", row_index);
                let asset = map_currency_code(&posting.currency);

                // Determine fee: use "0.00000000" (no per-row fee info in sample data)
                let fee = "0.00000000";

                out.push_str(&format!(
                    "\"{}\",\"{}\",\"{}\",\"{}\",\"\",\"currency\",\"{}\",\"{}\",\"{}\",\"\"\n",
                    txid,
                    refid,
                    time_str,
                    entry_type,
                    asset,
                    posting.amount,
                    fee,
                ));
            }
        }

        out
    }
}
