use chrono::NaiveDate;
use rand::rngs::StdRng;
use rand::Rng;
use rust_decimal::Decimal;

/// Triangular distribution: min, max, mode (most likely).
pub fn triangular(rng: &mut StdRng, min: f64, max: f64, mode: f64) -> f64 {
    let u: f64 = rng.gen();
    let fc = (mode - min) / (max - min);
    if u < fc {
        min + ((max - min) * (mode - min) * u).sqrt()
    } else {
        max - ((max - min) * (max - mode) * (1.0 - u)).sqrt()
    }
}

/// Round a f64 to a Decimal with given decimal places.
pub fn to_decimal(val: f64, dp: u8) -> Decimal {
    let scale = 10f64.powi(dp as i32);
    let rounded = (val * scale).round() / scale;
    Decimal::from_str_exact(&format!("{:.prec$}", rounded, prec = dp as usize))
        .unwrap_or_else(|_| Decimal::new((rounded * scale) as i64, dp as u32))
}

/// Pick a uniformly random date in range [start, end).
pub fn random_date(rng: &mut StdRng, start: NaiveDate, end: NaiveDate) -> NaiveDate {
    let days = (end - start).num_days();
    if days <= 0 {
        return start;
    }
    let offset = rng.gen_range(0..days);
    start + chrono::Duration::days(offset)
}

/// Pick a random element from a slice.
pub fn pick<'a, T>(rng: &mut StdRng, items: &'a [T]) -> &'a T {
    &items[rng.gen_range(0..items.len())]
}

/// Weighted random index selection. Weights don't need to sum to 1.
pub fn weighted_index(rng: &mut StdRng, weights: &[f64]) -> usize {
    let total: f64 = weights.iter().sum();
    let mut r = rng.gen::<f64>() * total;
    for (i, w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 {
            return i;
        }
    }
    weights.len() - 1
}

// Description pools

pub const GROCERY_STORES: &[&str] = &[
    "Carrefour", "Lidl", "Auchan", "Monoprix", "Leclerc",
    "Intermarché", "Casino", "Picard", "Aldi", "Franprix",
];

pub const RESTAURANTS: &[&str] = &[
    "Le Petit Bistrot", "Chez Marcel", "Sushi Palace", "Pizza Express",
    "Thai Garden", "La Brasserie", "Café de Flore", "Burger Joint",
    "Noodle Bar", "El Tapas",
];

pub const TRANSPORT: &[&str] = &[
    "RATP", "Uber", "Bolt", "SNCF", "BlaBlaCar",
    "Lime Scooter", "Navigo Pass", "Taxi G7", "Kapten", "FreeNow",
];

pub const SUBSCRIPTIONS: &[&str] = &[
    "Netflix", "Spotify", "Amazon Prime", "Disney+", "Apple iCloud",
    "YouTube Premium", "Notion", "1Password", "Adobe CC", "GitHub",
];

pub const SHOPPING: &[&str] = &[
    "Amazon", "Fnac", "Zara", "H&M", "Decathlon",
    "IKEA", "Apple Store", "Uniqlo", "Boulanger", "Darty",
];

pub const UTILITIES: &[&str] = &[
    "EDF Electricity", "Engie Gas", "Free Mobile", "Orange Internet",
    "Veolia Water", "SFR", "Bouygues Telecom", "TotalEnergies",
];

pub const HEALTH: &[&str] = &[
    "Pharmacie du Centre", "Dr. Martin", "Dentiste Dupont",
    "Optique Santé", "Kiné Sport", "Laboratoire Analyses",
];

pub const ENTERTAINMENT: &[&str] = &[
    "MK2 Cinéma", "Pathé Gaumont", "Fnac Spectacles",
    "Théâtre du Châtelet", "Parc Astérix", "Musée d'Orsay",
];

pub const EXCHANGE_DESCRIPTIONS: &[&str] = &[
    "Buy BTC", "Sell BTC", "Buy ETH", "Sell ETH",
    "Buy SOL", "Sell SOL", "Deposit EUR", "Withdraw EUR",
    "Buy LINK", "Buy UNI", "Staking reward",
];

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use std::str::FromStr;

    #[test]
    fn triangular_in_range() {
        let mut rng = StdRng::seed_from_u64(42);
        for _ in 0..1000 {
            let v = triangular(&mut rng, 10.0, 100.0, 50.0);
            assert!(v >= 10.0 && v <= 100.0, "got {v}");
        }
    }

    #[test]
    fn to_decimal_rounds() {
        let d = to_decimal(1.23456, 2);
        assert_eq!(d, Decimal::from_str("1.23").unwrap());
    }

    #[test]
    fn weighted_index_valid() {
        let mut rng = StdRng::seed_from_u64(42);
        let weights = [1.0, 2.0, 3.0];
        for _ in 0..100 {
            let idx = weighted_index(&mut rng, &weights);
            assert!(idx < 3);
        }
    }
}
