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
  | { type: "system"; action: "reversal" | "pad" | "recurring"; ref?: string };

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
