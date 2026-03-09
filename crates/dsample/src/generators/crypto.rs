use chrono::NaiveDate;
use rand::rngs::StdRng;
use rand::Rng;

use crate::accounts;
use crate::currencies;
use crate::distributions::{to_decimal, triangular, pick, weighted_index, random_tags, random_links, ActivityProfile, TAG_POOL, LINK_PREFIXES};
use crate::model::{SampleData, Entry};
use crate::price_sim::PriceSimulator;
use super::{ScenarioGenerator, simple_entry, trade_entry, fee_entry};

/// Tradeable (non-stablecoin) crypto codes.
const CRYPTO_CODES: &[&str] = &["BTC", "ETH", "SOL"];

pub struct CryptoGenerator;

impl ScenarioGenerator for CryptoGenerator {
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
        let profile = ActivityProfile::new(rng, start, end);

        let mut entries: Vec<Entry> = Vec::with_capacity(count + 1);

        // Opening balance: deposit 5000 EUR to exchange
        entries.push(simple_entry(
            start,
            "Initial deposit to Kraken",
            accounts::BANK_CHECKING,
            accounts::EXCHANGE_ASSETS_KRAKEN,
            to_decimal(5000.0, 2),
            "EUR",
        ));

        // Weights: buy_crypto=20, sell_crypto=15, deposit=5, withdraw=3, staking=5, fee=8
        let weights = [20.0, 15.0, 5.0, 3.0, 5.0, 8.0];

        // Step the price sim to a random state before generating
        for _ in 0..30 {
            price_sim.step(rng);
        }

        for _ in 0..count {
            let kind = weighted_index(rng, &weights);
            let date = profile.pick_date(rng);
            price_sim.step(rng);

            let entry = match kind {
                0 => {
                    // Buy crypto
                    let crypto = pick(rng, CRYPTO_CODES);
                    let eur_amount = triangular(rng, 100.0, 5000.0, 500.0);
                    let price = price_sim.price(crypto);
                    let crypto_amount = eur_amount / price;
                    let dp = currencies::decimal_places(crypto);
                    trade_entry(
                        date,
                        &format!("Buy {crypto}"),
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(crypto_amount, dp),
                        crypto,
                        to_decimal(eur_amount, 2),
                        "EUR",
                    )
                }
                1 => {
                    // Sell crypto
                    let crypto = pick(rng, CRYPTO_CODES);
                    let eur_amount = triangular(rng, 50.0, 3000.0, 400.0);
                    let price = price_sim.price(crypto);
                    let crypto_amount = eur_amount / price;
                    let dp = currencies::decimal_places(crypto);
                    trade_entry(
                        date,
                        &format!("Sell {crypto}"),
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(eur_amount, 2),
                        "EUR",
                        to_decimal(crypto_amount, dp),
                        crypto,
                    )
                }
                2 => {
                    // Deposit EUR to exchange
                    let amount = triangular(rng, 500.0, 10000.0, 2000.0);
                    simple_entry(
                        date,
                        "Deposit EUR to Kraken",
                        accounts::BANK_CHECKING,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                3 => {
                    // Withdraw EUR from exchange
                    let amount = triangular(rng, 200.0, 5000.0, 1000.0);
                    simple_entry(
                        date,
                        "Withdraw EUR from Kraken",
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        accounts::BANK_CHECKING,
                        to_decimal(amount, 2),
                        "EUR",
                    )
                }
                4 => {
                    // Staking reward
                    let crypto = pick(rng, CRYPTO_CODES);
                    let reward = rng.gen_range(0.0001..0.01);
                    let dp = currencies::decimal_places(crypto);
                    simple_entry(
                        date,
                        &format!("{crypto} staking reward"),
                        accounts::EXCHANGE_STAKING,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(reward, dp),
                        crypto,
                    )
                }
                _ => {
                    // Trading fee
                    let fee_pct = rng.gen_range(0.001..0.005);
                    let trade_amount = triangular(rng, 100.0, 5000.0, 500.0);
                    let fee = trade_amount * fee_pct;
                    fee_entry(
                        date,
                        "Trading fee",
                        accounts::EXCHANGE_FEES,
                        accounts::EXCHANGE_ASSETS_KRAKEN,
                        to_decimal(fee, 2),
                        "EUR",
                    )
                }
            };
            let mut entry = entry;
            match kind {
                0 | 1 => entry.tags = vec!["trading".to_string(), "crypto".to_string()],
                2 | 3 => entry.tags = vec!["transfer".to_string()],
                5 => entry.tags = vec!["fee".to_string()],
                _ => entry.tags = random_tags(rng, TAG_POOL),
            }
            entry.links = random_links(rng, LINK_PREFIXES);
            entries.push(entry);
        }

        entries.sort_by(|a, b| a.date.cmp(&b.date));

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
