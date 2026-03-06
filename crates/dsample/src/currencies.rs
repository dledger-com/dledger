use crate::model::Commodity;

pub fn fiat_currencies() -> Vec<Commodity> {
    vec![
        Commodity { code: "EUR".into(), decimal_places: 2 },
        Commodity { code: "USD".into(), decimal_places: 2 },
        Commodity { code: "GBP".into(), decimal_places: 2 },
    ]
}

pub fn crypto_currencies() -> Vec<Commodity> {
    vec![
        Commodity { code: "BTC".into(), decimal_places: 8 },
        Commodity { code: "ETH".into(), decimal_places: 8 },
        Commodity { code: "SOL".into(), decimal_places: 6 },
        Commodity { code: "USDT".into(), decimal_places: 2 },
        Commodity { code: "USDC".into(), decimal_places: 2 },
        Commodity { code: "LINK".into(), decimal_places: 6 },
        Commodity { code: "UNI".into(), decimal_places: 6 },
    ]
}

pub fn all_commodities() -> Vec<Commodity> {
    let mut c = fiat_currencies();
    c.extend(crypto_currencies());
    c
}

/// Approximate starting prices (in USD) for crypto assets, used as the initial
/// value for the geometric random walk price simulator.
pub fn starting_price_usd(code: &str) -> f64 {
    match code {
        "BTC" => 30_000.0,
        "ETH" => 2_000.0,
        "SOL" => 25.0,
        "USDT" | "USDC" => 1.0,
        "LINK" => 7.0,
        "UNI" => 5.0,
        _ => 1.0,
    }
}

/// Decimal places for a given currency code.
pub fn decimal_places(code: &str) -> u8 {
    match code {
        "EUR" | "USD" | "GBP" | "USDT" | "USDC" => 2,
        "BTC" | "ETH" => 8,
        "SOL" | "LINK" | "UNI" => 6,
        _ => 2,
    }
}
