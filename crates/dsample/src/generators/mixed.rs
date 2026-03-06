use chrono::NaiveDate;
use rand::rngs::StdRng;

use crate::currencies;
use crate::model::SampleData;
use super::ScenarioGenerator;
use super::personal::PersonalGenerator;
use super::crypto::CryptoGenerator;

pub struct MixedGenerator;

impl ScenarioGenerator for MixedGenerator {
    fn generate(
        &self,
        rng: &mut StdRng,
        count: usize,
        start: NaiveDate,
        end: NaiveDate,
        with_prices: bool,
    ) -> SampleData {
        let personal_count = count * 60 / 100;
        let crypto_count = count - personal_count;

        let personal = PersonalGenerator.generate(rng, personal_count, start, end, with_prices);
        let crypto = CryptoGenerator.generate(rng, crypto_count, start, end, with_prices);

        let mut data = SampleData {
            commodities: currencies::all_commodities(),
            entries: Vec::new(),
            prices: Vec::new(),
        };
        data.merge(personal);
        data.merge(crypto);
        data.sort_by_date();
        data
    }
}
