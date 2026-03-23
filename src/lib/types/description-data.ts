export type DescriptionData =
  | { type: "cex-trade"; exchange: string; spent: string; received: string }
  | { type: "cex-transfer"; exchange: string; direction: "deposit" | "withdrawal"; currency: string }
  | { type: "cex-reward"; exchange: string; kind: string; currency: string }
  | { type: "cex-operation"; exchange: string; operation: string; currency: string }
  | { type: "bank"; bank: string; text: string; reference?: string }
  | { type: "onchain-transfer"; chain: string; currency: string; direction: "sent" | "received" | "self"; counterparty?: string; txHash: string; tokenCount?: number }
  | { type: "onchain-contract"; chain: string; currency: string; action: "creation" | "internal-transfer"; txHash: string }
  | { type: "defi"; protocol: string; action: string; chain: string; txHash: string; summary?: string }
  | { type: "generic-import"; source: "csv" | "ofx" | "pdf" | "ledger"; text: string; presetId?: string }
  | { type: "manual"; text: string }
  | { type: "btc-transfer"; direction: "sent" | "received" | "self" | "consolidation"; counterparty?: string; txid: string }
  | { type: "sol-transfer"; direction: "sent" | "received" | "self"; counterparty?: string; signature: string; tokenSymbol?: string }
  | { type: "sol-defi"; protocol: string; action: string; signature: string; summary?: string }
  | { type: "hl-fill"; coin: string; side: "long" | "short"; closedPnl?: string; spent?: string; received?: string }
  | { type: "hl-funding"; coin: string; usdc: string }
  | { type: "hl-ledger"; action: "deposit" | "withdrawal" | "liquidation" | "transfer"; usdc?: string }
  | { type: "system"; action: "reversal" | "pad" | "recurring"; ref?: string };

// ── Centralized builders (use these instead of constructing DescriptionData inline) ──

/** Trade (CEX or DEX spot): "Exchange trade: SPENT → RECEIVED" */
export function tradeDescription(source: string, spent: string, received: string): DescriptionData {
  return { type: "cex-trade", exchange: source, spent, received };
}

/** Deposit or withdrawal: "Exchange deposit: CURRENCY" */
export function transferDescription(source: string, direction: "deposit" | "withdrawal", currency: string): DescriptionData {
  return { type: "cex-transfer", exchange: source, direction, currency };
}

/** Staking/airdrop reward: "Exchange staking reward: CURRENCY" */
export function rewardDescription(source: string, kind: string, currency: string): DescriptionData {
  return { type: "cex-reward", exchange: source, kind, currency };
}

/** Generic operation: "Exchange conversion: CURRENCY" */
export function operationDescription(source: string, operation: string, currency: string): DescriptionData {
  return { type: "cex-operation", exchange: source, operation, currency };
}

/** On-chain transfer (EVM): "Send ETH on Ethereum to 0x..." */
export function onchainTransferDescription(
  chain: string, currency: string, direction: "sent" | "received" | "self",
  opts?: { counterparty?: string; txHash?: string; tokenCount?: number },
): DescriptionData {
  return { type: "onchain-transfer", chain, currency, direction, counterparty: opts?.counterparty, txHash: opts?.txHash ?? "", tokenCount: opts?.tokenCount };
}

/** On-chain contract interaction */
export function onchainContractDescription(chain: string, currency: string, action: "creation" | "internal-transfer", txHash: string): DescriptionData {
  return { type: "onchain-contract", chain, currency, action, txHash };
}

/** DeFi protocol action: "Uniswap: swap on Ethereum" */
export function defiActionDescription(protocol: string, action: string, chain: string, txHash: string, summary?: string): DescriptionData {
  return { type: "defi", protocol, action, chain, txHash, summary };
}

/** Bitcoin transfer: "Send BTC on Bitcoin to abc..." */
export function btcTransferDescription(direction: "sent" | "received" | "self" | "consolidation", txid: string, counterparty?: string): DescriptionData {
  return { type: "btc-transfer", direction, txid, counterparty };
}

/** Solana transfer: "Send SOL on Solana to abc..." */
export function solTransferDescription(direction: "sent" | "received" | "self", signature: string, opts?: { counterparty?: string; tokenSymbol?: string }): DescriptionData {
  return { type: "sol-transfer", direction, signature, counterparty: opts?.counterparty, tokenSymbol: opts?.tokenSymbol };
}

/** Solana DeFi action: "Jupiter: swap on Solana" */
export function solDefiDescription(protocol: string, action: string, signature: string, summary?: string): DescriptionData {
  return { type: "sol-defi", protocol, action, signature, summary };
}

/** Perpetual futures trade: "Hyperliquid BTC long trade" */
export function perpTradeDescription(source: string, coin: string, side: "long" | "short"): DescriptionData {
  return { type: "hl-fill", coin, side };
}

/** Funding payment: "Hyperliquid funding BTC" */
export function fundingDescription(_source: string, coin: string): DescriptionData {
  return { type: "hl-funding", coin, usdc: "" };
}

/** Bank transaction: "La Banque Postale: Virement" */
export function bankDescription(bank: string, text: string, reference?: string): DescriptionData {
  return { type: "bank", bank, text, reference };
}

export function renderDescription(data: DescriptionData): string {
  switch (data.type) {
    case "cex-trade":
      return `${data.exchange} trade: ${data.spent} → ${data.received}`;
    case "cex-transfer":
      return `${data.exchange} ${data.direction}: ${data.currency}`;
    case "cex-reward":
      return `${data.exchange} ${data.kind} reward: ${data.currency}`;
    case "cex-operation":
      return `${data.exchange} ${data.operation}: ${data.currency}`;
    case "bank":
      return data.bank ? `${data.bank}: ${data.text}` : data.text;
    case "onchain-transfer": {
      const dir = data.direction === "sent" ? "Send" : data.direction === "received" ? "Receive" : "Self-transfer";
      const cp = data.counterparty ? ` ${data.direction === "sent" ? "to" : "from"} ${data.counterparty}` : "";
      const count = data.tokenCount && data.tokenCount > 1 ? ` (${data.tokenCount} tokens)` : "";
      return `${dir} ${data.currency} on ${data.chain}${cp}${count}`;
    }
    case "onchain-contract":
      return data.action === "creation"
        ? `Contract creation on ${data.chain}`
        : `Internal transfer ${data.currency} on ${data.chain}`;
    case "defi":
      return data.summary ?? `${data.protocol}: ${data.action} on ${data.chain}`;
    case "btc-transfer": {
      const dir = data.direction === "sent" ? "Send"
        : data.direction === "received" ? "Receive"
        : data.direction === "self" ? "Self-transfer"
        : "Consolidation";
      const cp = data.counterparty ? ` ${data.direction === "sent" ? "to" : "from"} ${data.counterparty}` : "";
      return `${dir} BTC on Bitcoin${cp}`;
    }
    case "sol-transfer": {
      const dir = data.direction === "sent" ? "Send"
        : data.direction === "received" ? "Receive"
        : "Self-transfer";
      const token = data.tokenSymbol ? ` ${data.tokenSymbol}` : " SOL";
      const cp = data.counterparty ? ` ${data.direction === "sent" ? "to" : "from"} ${data.counterparty}` : "";
      return `${dir}${token} on Solana${cp}`;
    }
    case "sol-defi":
      return data.summary ?? `${data.protocol}: ${data.action} on Solana`;
    case "hl-fill": {
      if (data.spent && data.received) {
        return `Hyperliquid trade: ${data.spent} → ${data.received}`;
      }
      return `Hyperliquid ${data.coin} ${data.side} trade`;
    }
    case "hl-funding":
      return `Hyperliquid funding ${data.coin}`;
    case "hl-ledger":
      return `Hyperliquid ${data.action}: USDC`;
    case "generic-import":
      return data.text;
    case "manual":
      return data.text;
    case "system":
      switch (data.action) {
        case "reversal": return `Reversal${data.ref ? ` of: ${data.ref}` : ""}`;
        case "pad": return `Pad${data.ref ? `: ${data.ref}` : ""}`;
        case "recurring": return `Recurring${data.ref ? `: ${data.ref}` : ""}`;
      }
  }
}
