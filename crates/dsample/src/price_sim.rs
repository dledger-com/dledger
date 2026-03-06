use chrono::NaiveDate;
use rand::rngs::StdRng;
use rand::Rng;
use std::collections::BTreeMap;

use crate::currencies::starting_price_usd;
use crate::distributions::to_decimal;
use crate::model::PriceDirective;

/// Geometric random walk price simulator.
/// Generates daily prices for each commodity from start to end date.
pub struct PriceSimulator {
    /// Current price per commodity (in USD).
    prices: BTreeMap<String, f64>,
    /// Daily volatility (as fraction, e.g. 0.03 = 3%).
    daily_vol: f64,
    /// Daily drift (slight upward bias).
    daily_drift: f64,
}

impl PriceSimulator {
    pub fn new(commodities: &[String], daily_vol: f64) -> Self {
        let mut prices = BTreeMap::new();
        for code in commodities {
            prices.insert(code.clone(), starting_price_usd(code));
        }
        Self {
            prices,
            daily_vol,
            daily_drift: 0.0001, // very slight upward drift
        }
    }

    /// Step all prices forward by one day using geometric Brownian motion.
    pub fn step(&mut self, rng: &mut StdRng) {
        for price in self.prices.values_mut() {
            // Skip stablecoins
            if (*price - 1.0).abs() < 0.1 {
                // Small noise for stablecoins
                let noise: f64 = rng.gen::<f64>() * 0.002 - 0.001;
                *price = (*price * (1.0 + noise)).max(0.99);
                continue;
            }
            let z: f64 = sample_normal(rng);
            let ret = self.daily_drift + self.daily_vol * z;
            *price *= (1.0 + ret).max(0.01);
        }
    }

    /// Get current price for a commodity.
    pub fn price(&self, code: &str) -> f64 {
        self.prices.get(code).copied().unwrap_or(1.0)
    }

    /// Generate daily price directives for all commodities over a date range.
    pub fn generate_prices(
        &mut self,
        rng: &mut StdRng,
        start: NaiveDate,
        end: NaiveDate,
        target_currency: &str,
    ) -> Vec<PriceDirective> {
        let mut directives = Vec::new();
        let mut date = start;
        while date < end {
            self.step(rng);
            for (code, &price) in &self.prices {
                // Don't emit price for target currency itself
                if code == target_currency {
                    continue;
                }
                directives.push(PriceDirective {
                    date,
                    commodity: code.clone(),
                    price: to_decimal(price, 2),
                    target_currency: target_currency.to_string(),
                });
            }
            date += chrono::Duration::days(1);
        }
        directives
    }
}

/// Box-Muller transform for standard normal samples.
fn sample_normal(rng: &mut StdRng) -> f64 {
    let u1: f64 = rng.gen::<f64>().max(1e-10);
    let u2: f64 = rng.gen();
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn prices_stay_positive() {
        let mut rng = StdRng::seed_from_u64(42);
        let mut sim = PriceSimulator::new(
            &["BTC".to_string(), "ETH".to_string()],
            0.03,
        );
        for _ in 0..1000 {
            sim.step(&mut rng);
            assert!(sim.price("BTC") > 0.0);
            assert!(sim.price("ETH") > 0.0);
        }
    }

    #[test]
    fn stablecoins_stay_near_peg() {
        let mut rng = StdRng::seed_from_u64(42);
        let mut sim = PriceSimulator::new(&["USDT".to_string()], 0.03);
        for _ in 0..365 {
            sim.step(&mut rng);
        }
        let p = sim.price("USDT");
        assert!(p > 0.95 && p < 1.05, "USDT price drifted to {p}");
    }
}
