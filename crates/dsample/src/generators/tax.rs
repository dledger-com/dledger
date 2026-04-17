use chrono::NaiveDate;
use rand::rngs::StdRng;
use rand::Rng;

use crate::accounts;
use crate::currencies;
use crate::distributions::{to_decimal, triangular, weighted_index, random_links, LINK_PREFIXES};
use crate::model::{SampleData, Entry};
use crate::price_sim::PriceSimulator;
use super::{ScenarioGenerator, trade_entry};

/// Tradeable crypto codes for tax scenarios.
const CRYPTO_CODES: &[&str] = &["BTC", "ETH", "SOL"];

pub struct TaxGenerator;

impl ScenarioGenerator for TaxGenerator {
    fn generate(
        &self,
        rng: &mut StdRng,
        count: usize,
        start: NaiveDate,
        end: NaiveDate,
        with_prices: bool,
    ) -> SampleData {
        let crypto_codes: Vec<String> = CRYPTO_CODES.iter().map(|s| s.to_string()).collect();
        let mut price_sim = PriceSimulator::new(&crypto_codes, 0.025);

        let mut entries: Vec<Entry> = Vec::with_capacity(count);

        let total_days = (end - start).num_days().max(1);

        // Weights: ~60% acquisitions, ~40% dispositions
        let weights = [60.0, 40.0];

        // Step price sim forward a bit for initial state
        for _ in 0..30 {
            price_sim.step(rng);
        }

        for _ in 0..count {
            let kind = weighted_index(rng, &weights);
            price_sim.step(rng);

            match kind {
                0 => {
                    // Acquisition: buy crypto with EUR
                    // Spread acquisitions across the full date range
                    let day_offset = rng.gen_range(0..total_days);
                    let date = start + chrono::Duration::days(day_offset);

                    let crypto = CRYPTO_CODES[rng.gen_range(0..CRYPTO_CODES.len())];
                    let eur_amount = triangular(rng, 100.0, 10000.0, 1000.0);
                    let price = price_sim.price(crypto);
                    let crypto_amount = eur_amount / price;
                    let dp = currencies::decimal_places(crypto);

                    let mut entry = trade_entry(
                        date,
                        &format!("Buy {crypto}"),
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(crypto_amount, dp),
                        crypto,
                        to_decimal(eur_amount, 2),
                        "EUR",
                    );
                    entry.tags = vec!["trading".to_string(), "crypto".to_string()];
                    entry.links = random_links(rng, LINK_PREFIXES);
                    entries.push(entry);
                }
                _ => {
                    // Disposition: sell crypto for EUR
                    // Concentrate dispositions in the later portion of the range
                    let bias = rng.gen::<f64>().powi(2); // squared bias toward 0, then invert
                    let day_offset = ((1.0 - bias) * total_days as f64) as i64;
                    let date = start + chrono::Duration::days(day_offset.min(total_days - 1));

                    let crypto = CRYPTO_CODES[rng.gen_range(0..CRYPTO_CODES.len())];
                    let eur_amount = triangular(rng, 50.0, 8000.0, 800.0);
                    let price = price_sim.price(crypto);
                    let crypto_amount = eur_amount / price;
                    let dp = currencies::decimal_places(crypto);

                    // Sell: crypto leaves exchange via Equity:Trading, EUR arrives at bank
                    let mut entry = trade_entry(
                        date,
                        &format!("Sell {crypto}"),
                        accounts::BANK_CHECKING,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(eur_amount, 2),
                        "EUR",
                        to_decimal(crypto_amount, dp),
                        crypto,
                    );
                    entry.tags = vec!["trading".to_string(), "crypto".to_string(), "tax-deductible".to_string()];
                    entry.links = random_links(rng, LINK_PREFIXES);
                    entries.push(entry);
                }
            }
        }

        entries.sort_by_key(|a| a.date);

        let prices = if with_prices {
            price_sim.generate_prices(rng, start, end, "EUR")
        } else {
            Vec::new()
        };

        SampleData {
            commodities: currencies::all_commodities(),
            entries,
            prices,
        }
    }
}
