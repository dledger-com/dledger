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
  bitcoin:   `${TW}/bitcoin/info/logo.png`,
  btc:       `${TW}/bitcoin/info/logo.png`,
  sol:       `${TW}/solana/info/logo.png`,
  solana:    `${TW}/solana/info/logo.png`,
  cardano:   `${TW}/cardano/info/logo.png`,
  xmr:       `${TW}/monero/info/logo.png`,
  tron:      `${TW}/tron/info/logo.png`,
  stellar:   `${TW}/stellar/info/logo.png`,
  xrp:       `${TW}/xrp/info/logo.png`,
  cosmos:    `${TW}/cosmos/info/logo.png`,
  polkadot:  `${TW}/polkadot/info/logo.png`,
  near:      `${TW}/near/info/logo.png`,
  algorand:  `${TW}/algorand/info/logo.png`,
  tezos:     `${TW}/tezos/info/logo.png`,
  ton:       `${TW}/ton/info/logo.png`,
  aptos:     `${TW}/aptos/info/logo.png`,
  sui:       `${TW}/sui/info/logo.png`,
  hedera:    `${TW}/hedera/info/logo.png`,
  bittensor: `${TW}/bittensor/info/logo.png`,
  hl:        "", // Hyperliquid — no Trust Wallet logo yet
  doge:      `${TW}/doge/info/logo.png`,
  ltc:       `${TW}/litecoin/info/logo.png`,
  bch:       `${TW}/bitcoincash/info/logo.png`,
  kaspa:     `${TW}/kaspa/info/logo.png`,
  zcash:     `${TW}/zcash/info/logo.png`,
  stacks:    `${TW}/stacks/info/logo.png`,
};

export function getChainIconUrl(chainId: number): string | null {
  return CHAIN_ICONS[chainId] || null;
}

export function getNamedChainIconUrl(chainName: string): string | null {
  return NAMED_CHAIN_ICONS[chainName.toLowerCase()] || null;
}
