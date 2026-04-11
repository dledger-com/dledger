/**
 * Static map of EVM chain IDs and named chains to icon URLs.
 * Uses Trust Wallet Assets CDN for well-known chains.
 */

const TW = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

/** EVM chain_id → icon URL */
export const CHAIN_ICONS: Record<number, string> = {
  1:      `${TW}/ethereum/info/logo.png`,
  10:     `${TW}/optimism/info/logo.png`,
  14:     `${TW}/flare/info/logo.png`,
  25:     `${TW}/cronos/info/logo.png`,
  42161:  `${TW}/arbitrum/info/logo.png`,
  8453:   `${TW}/base/info/logo.png`,
  59144:  `${TW}/linea/info/logo.png`,
  534352: `${TW}/scroll/info/logo.png`,
  81457:  `${TW}/blast/info/logo.png`,
  56:     `${TW}/smartchain/info/logo.png`,
  137:    `${TW}/polygon/info/logo.png`,
  43114:  `${TW}/avalanchec/info/logo.png`,
  100:    `${TW}/xdai/info/logo.png`,
  61:     `${TW}/classic/info/logo.png`,
  1284:   `${TW}/moonbeam/info/logo.png`,
  1285:   `${TW}/moonriver/info/logo.png`,
  1329:   `${TW}/sei/info/logo.png`,
  5000:   `${TW}/mantle/info/logo.png`,
  42220:  `${TW}/celo/info/logo.png`,
  250:    `${TW}/fantom/info/logo.png`,
};

/** Named chain ID (non-EVM) → icon URL */
export const NAMED_CHAIN_ICONS: Record<string, string> = {
  ethereum:  `${TW}/ethereum/info/logo.png`,
  eth:       `${TW}/ethereum/info/logo.png`,
  bitcoin:   `${TW}/bitcoin/info/logo.png`,
  btc:       `${TW}/bitcoin/info/logo.png`,
  sol:       `${TW}/solana/info/logo.png`,
  solana:    `${TW}/solana/info/logo.png`,
  cardano:   `${TW}/cardano/info/logo.png`,
  xmr:       "https://coin-images.coingecko.com/coins/images/69/small/monero_logo.png",
  tron:      `${TW}/tron/info/logo.png`,
  stellar:   `${TW}/stellar/info/logo.png`,
  xrp:       `${TW}/ripple/info/logo.png`,
  cosmos:    `${TW}/cosmos/info/logo.png`,
  polkadot:  `${TW}/polkadot/info/logo.png`,
  near:      `${TW}/near/info/logo.png`,
  algorand:  `${TW}/algorand/info/logo.png`,
  tezos:     `${TW}/tezos/info/logo.png`,
  ton:       `${TW}/ton/info/logo.png`,
  aptos:     `${TW}/aptos/info/logo.png`,
  sui:       `${TW}/sui/info/logo.png`,
  hedera:    `${TW}/hedera/info/logo.png`,
  bitshares: "https://coin-images.coingecko.com/coins/images/95/small/bts.png",
  bittensor: "https://coin-images.coingecko.com/coins/images/28452/small/ARUsPeNQ_400x400.jpeg",
  hl:        "https://coin-images.coingecko.com/coins/images/50882/small/hyperliquid.jpg?1729431300",
  doge:      `${TW}/doge/info/logo.png`,
  ltc:       `${TW}/litecoin/info/logo.png`,
  bch:       `${TW}/bitcoincash/info/logo.png`,
  kaspa:     "https://coin-images.coingecko.com/coins/images/25751/small/kaspa-icon-exchanges.png",
  zcash:     `${TW}/zcash/info/logo.png`,
  stacks:    "https://coin-images.coingecko.com/coins/images/2069/small/Stacks_logo_full.png",
};

export function getChainIconUrl(chainId: number): string | null {
  return CHAIN_ICONS[chainId] || null;
}

export function getNamedChainIconUrl(chainName: string): string | null {
  return NAMED_CHAIN_ICONS[chainName.toLowerCase()] || null;
}

/** Register a dynamic chain icon URL at runtime (used by plugin blockchain sources). */
export function registerChainIcon(chainId: string, url: string): void {
  NAMED_CHAIN_ICONS[chainId.toLowerCase()] = url;
}
