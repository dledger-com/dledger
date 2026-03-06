use clap::{Parser, ValueEnum};

#[derive(Debug, Clone, ValueEnum)]
pub enum Format {
    Ledger,
    Beancount,
    Hledger,
    KrakenCsv,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum Scenario {
    Personal,
    Crypto,
    Mixed,
    Tax,
}

#[derive(Debug, Clone, ValueEnum)]
pub enum Size {
    Small,
    Medium,
    Large,
    Huge,
}

impl Size {
    pub fn entry_count(&self) -> usize {
        match self {
            Size::Small => 100,
            Size::Medium => 1_000,
            Size::Large => 10_000,
            Size::Huge => 100_000,
        }
    }
}

#[derive(Debug, Parser)]
#[command(name = "dsample", about = "Sample data generator for dledger stress testing")]
pub struct Cli {
    /// Output file (default: stdout)
    #[arg(short, long)]
    pub output: Option<String>,

    /// Output format
    #[arg(short, long, value_enum, default_value_t = Format::Ledger)]
    pub format: Format,

    /// Scenario to generate
    #[arg(short, long, value_enum, default_value_t = Scenario::Mixed)]
    pub scenario: Scenario,

    /// Exact entry count (overrides --size)
    #[arg(short = 'n', long)]
    pub entries: Option<usize>,

    /// Preset size
    #[arg(long, value_enum, default_value_t = Size::Medium)]
    pub size: Size,

    /// Date range span in years
    #[arg(long, default_value_t = 3)]
    pub years: u32,

    /// RNG seed
    #[arg(long, default_value_t = 42)]
    pub seed: u64,

    /// Include price directives
    #[arg(long)]
    pub with_prices: bool,

    /// Start date (YYYY-MM-DD). Defaults to N years ago.
    #[arg(long)]
    pub start_date: Option<String>,
}
