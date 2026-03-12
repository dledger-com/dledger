/**
 * Institution registry for French tax form 3916-bis declarations.
 *
 * Contains legal entity details for all exchanges, neobanks, and platforms
 * supported by dledger. Used by Form3916bisTab and CSV export.
 *
 * Sources: AMF PSAN whitelist, Cryptoast 3916-bis reference, company registries,
 * exchange legal pages. See plan document for full source list.
 */

export interface InstitutionInfo {
  /** Legal entity name for the form */
  legalEntity: string;
  /** Full registered address */
  address: string;
  /** Country of incorporation */
  country: string;
  /** Website URL */
  url: string;
  /** Whether it's a foreign institution requiring declaration */
  foreign: boolean;
  /**
   * If the institution became French on a specific date,
   * accounts were foreign BEFORE this date. Format: "YYYY-MM-DD".
   */
  foreignBefore?: string;
  /**
   * If the institution lost its French status, accounts became foreign again
   * AFTER this date. Format: "YYYY-MM-DD".
   */
  foreignAfter?: string;
  /** Platform shut down / entered liquidation. Format: "YYYY-MM-DD" */
  closedDate?: string;
  /** Non-custodial — no declaration needed */
  nonCustodial?: boolean;
  /** Note shown in UI */
  note?: string;
}

/** Registry keyed by exchange/preset/parser ID */
export const INSTITUTION_REGISTRY: Record<string, InstitutionInfo> = {
  // ── CEX Adapters (ExchangeId-keyed) ──────────────────────────────────

  binance: {
    legalEntity: "Binance France SAS",
    address: "1 rue de Stockholm, 75008 Paris",
    country: "France",
    url: "binance.com",
    foreign: false,
    foreignBefore: "2022-05-04",
    note: "PSAN E2022-037. Before May 2022: Binance Holdings Ltd, Cayman Islands",
  },
  kraken: {
    legalEntity: "Payward Europe Solutions Limited",
    address: "70 Sir John Rogerson's Quay, Dublin 2, D02 R296",
    country: "Ireland",
    url: "kraken.com",
    foreign: true,
    note: "MiCA via Central Bank of Ireland",
  },
  coinbase: {
    legalEntity: "Coinbase Europe Limited",
    address: "70 Sir John Rogerson's Quay, Dublin 2, D02 R296",
    country: "Ireland",
    url: "coinbase.com",
    foreign: true,
    note: "PSAN E2023-110 but Irish entity",
  },
  bybit: {
    legalEntity: "Bybit Fintech FZE",
    address: "One Central, Dubai World Trade Centre, Dubai",
    country: "UAE",
    url: "bybit.com",
    foreign: true,
    note: "AMF blacklisted May 2022",
  },
  okx: {
    legalEntity: "OKCoin Europe Limited",
    address: "Piazzetta Business Plaza, Tower 1, Level 3, Triq it-Torri, Sliema SLM 1562",
    country: "Malta",
    url: "okx.com",
    foreign: true,
    note: "Had French SAS (PSAN E2023-106), delisted Jul 2025. MiCA via MFSA",
  },
  bitstamp: {
    legalEntity: "Bitstamp Europe S.A.",
    address: "40 avenue Monterey, L-2163 Luxembourg",
    country: "Luxembourg",
    url: "bitstamp.net",
    foreign: true,
    note: "PSAN E2023-064, MiCA via CSSF",
  },
  cryptocom: {
    legalEntity: "Foris DAX MT Limited",
    address: "Level 7, Spinola Park, Triq Mikiel Ang Borg, St. Julians SPK 1000",
    country: "Malta",
    url: "crypto.com",
    foreign: true,
    note: "PSAN registered (Maltese entity). MiCA via MFSA",
  },
  volet: {
    legalEntity: "Queensland Foreign Exchange Inc.",
    address: "36 Toronto Street, Suite 850, Toronto, Ontario M5C 2C5",
    country: "Canada",
    url: "volet.com",
    foreign: true,
    note: "Formerly AdvCash (rebranded Mar 2024)",
  },

  // ── CSV-only Presets ─────────────────────────────────────────────────

  bisq: {
    legalEntity: "",
    address: "",
    country: "",
    url: "bisq.network",
    foreign: false,
    nonCustodial: true,
    note: "Non-custodial DEX, no account to declare",
  },
  bitfinex: {
    legalEntity: "iFinex Inc.",
    address: "Jayla Place, Wickhams Cay I, Road Town, Tortola VG1110",
    country: "British Virgin Islands",
    url: "bitfinex.com",
    foreign: true,
  },
  bittrex: {
    legalEntity: "Bittrex Global GmbH",
    address: "Dr. Grass-Strasse 12, 9490 Vaduz",
    country: "Liechtenstein",
    url: "bittrex.com",
    foreign: true,
    closedDate: "2023-12-04",
    note: "Shut down Dec 4, 2023. Liquidation Mar 2024",
  },
  coinlist: {
    legalEntity: "CoinList Markets LLC",
    address: "900 Kearny St, Suite 500, San Francisco, CA 94133",
    country: "USA",
    url: "coinlist.co",
    foreign: true,
  },
  gateio: {
    legalEntity: "Gate Technology Ltd",
    address: "The Core, Triq il-Wied ta' l-Imsida, Msida MSD 9021",
    country: "Malta",
    url: "gate.io",
    foreign: true,
    note: "MiCA license from MFSA Sep 2025",
  },
  nexo: {
    legalEntity: "Nexo AG",
    address: "Grafenaustrasse 15, 6300 Zug",
    country: "Switzerland",
    url: "nexo.com",
    foreign: true,
  },
  poloniex: {
    legalEntity: "Polo Digital Assets Ltd",
    address: "F20, 1st Floor, Eden Plaza, Eden Island",
    country: "Seychelles",
    url: "poloniex.com",
    foreign: true,
    note: "Hacked Nov 2023, reduced operations",
  },
  "yield-app": {
    legalEntity: "Yield App Ltd",
    address: "",
    country: "Seychelles",
    url: "yield.app",
    foreign: true,
    closedDate: "2024-07-01",
    note: "Liquidation Jul 1, 2024",
  },

  // ── Banks / Neobanks ────────────────────────────────────────────────

  n26: {
    legalEntity: "N26 Bank SE",
    address: "Voltairestrasse 8, 10179 Berlin",
    country: "Germany",
    url: "n26.com",
    foreign: true,
    note: "German bank — requires form 3916 (not 3916-bis) for bank accounts",
  },
  "pdf-n26": {
    legalEntity: "N26 Bank SE",
    address: "Voltairestrasse 8, 10179 Berlin",
    country: "Germany",
    url: "n26.com",
    foreign: true,
    note: "German bank — requires form 3916 (not 3916-bis) for bank accounts",
  },
  "pdf-nuri": {
    legalEntity: "Nuri GmbH",
    address: "Prinzessinnenstrasse 19/20, 10969 Berlin",
    country: "Germany",
    url: "",
    foreign: true,
    closedDate: "2022-12-18",
    note: "Insolvent Aug 9, 2022. Accounts closed Dec 18, 2022",
  },
  "pdf-deblock": {
    legalEntity: "Deblock SAS",
    address: "1 Cours du Havre, 75008 Paris",
    country: "France",
    url: "deblock.com",
    foreign: false,
    note: "French company, PSAN + MiCA approved",
  },
  revolut: {
    legalEntity: "Revolut Bank UAB",
    address: "Konstitucijos ave. 21B, LT-08130 Vilnius",
    country: "Lithuania",
    url: "revolut.com",
    foreign: true,
    note: "Lithuanian banking license",
  },
  "la-banque-postale": {
    legalEntity: "La Banque Postale SA",
    address: "",
    country: "France",
    url: "labanquepostale.fr",
    foreign: false,
  },
  "pdf-lbp": {
    legalEntity: "La Banque Postale SA",
    address: "",
    country: "France",
    url: "labanquepostale.fr",
    foreign: false,
  },
};

/**
 * Check if an institution requires 3916-bis declaration for a given tax year.
 * Returns true if the institution was foreign for any part of that year.
 */
export function requiresDeclaration(id: string, taxYear: number): boolean {
  const info = INSTITUTION_REGISTRY[id];
  if (!info) return true; // unknown → assume foreign

  if (info.nonCustodial) return false;

  // Closed before the tax year started → no declaration needed
  if (info.closedDate) {
    const closedYear = parseInt(info.closedDate.substring(0, 4), 10);
    if (closedYear < taxYear) return false;
  }

  // Always-French entity with no temporal caveats
  if (!info.foreign && !info.foreignBefore && !info.foreignAfter) return false;

  // Always-foreign entity
  if (info.foreign && !info.foreignBefore && !info.foreignAfter) return true;

  // Became French on foreignBefore date → foreign for years before that date's year
  if (info.foreignBefore) {
    const switchYear = parseInt(info.foreignBefore.substring(0, 4), 10);
    // If the tax year is before the switch year, it was foreign the whole year
    if (taxYear < switchYear) return true;
    // If the switch happened during the tax year, it was foreign for part of the year
    if (taxYear === switchYear) return true;
  }

  // Lost French status on foreignAfter date → foreign from that date's year onward
  if (info.foreignAfter) {
    const lostYear = parseInt(info.foreignAfter.substring(0, 4), 10);
    if (taxYear >= lostYear) return true;
  }

  // Has foreignBefore but tax year is after switch → French, no declaration
  if (info.foreignBefore && !info.foreignAfter) {
    const switchYear = parseInt(info.foreignBefore.substring(0, 4), 10);
    if (taxYear > switchYear) return false;
  }

  return false;
}

/** Get institution info, with fallback for unknown IDs */
export function getInstitution(id: string): InstitutionInfo | undefined {
  return INSTITUTION_REGISTRY[id];
}
