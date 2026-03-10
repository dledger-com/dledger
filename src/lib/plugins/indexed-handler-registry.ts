import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "../handlers/types.js";
import type { TransactionHandlerExtension, HandlerHints } from "./types.js";

/**
 * High-performance handler registry that indexes handlers by address, symbol,
 * and prefix hints for O(1) candidate lookup instead of linear scan.
 */
export class IndexedHandlerRegistry {
  private universalHandlers: TransactionHandlerExtension[] = [];
  private addressIndex = new Map<string, TransactionHandlerExtension[]>();
  private prefixIndex: { prefix: string; ext: TransactionHandlerExtension }[] = [];
  private symbolIndex = new Map<string, TransactionHandlerExtension[]>();
  private patternIndex: { pattern: RegExp; ext: TransactionHandlerExtension }[] = [];
  private allExtensions: TransactionHandlerExtension[] = [];

  register(ext: TransactionHandlerExtension): void {
    this.allExtensions.push(ext);

    if (!ext.hints) {
      this.universalHandlers.push(ext);
      return;
    }

    const hints = ext.hints;
    let hasSpecificHints = false;

    if (hints.addresses && hints.addresses.length > 0) {
      hasSpecificHints = true;
      for (const addr of hints.addresses) {
        const key = addr.toLowerCase();
        const list = this.addressIndex.get(key);
        if (list) list.push(ext);
        else this.addressIndex.set(key, [ext]);
      }
    }

    if (hints.addressPrefixes && hints.addressPrefixes.length > 0) {
      hasSpecificHints = true;
      for (const prefix of hints.addressPrefixes) {
        this.prefixIndex.push({ prefix: prefix.toLowerCase(), ext });
      }
    }

    if (hints.tokenSymbols && hints.tokenSymbols.length > 0) {
      hasSpecificHints = true;
      for (const sym of hints.tokenSymbols) {
        const key = sym.toUpperCase();
        const list = this.symbolIndex.get(key);
        if (list) list.push(ext);
        else this.symbolIndex.set(key, [ext]);
      }
    }

    if (hints.tokenPatterns && hints.tokenPatterns.length > 0) {
      hasSpecificHints = true;
      for (const pattern of hints.tokenPatterns) {
        this.patternIndex.push({ pattern, ext });
      }
    }

    if (!hasSpecificHints) {
      this.universalHandlers.push(ext);
    }
  }

  getAll(): TransactionHandler[] {
    return this.allExtensions.map((e) => e.handler);
  }

  /**
   * Find the best matching handler for a transaction group.
   * Only calls match() on candidates from index + universal handlers.
   */
  findBest(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): TransactionHandler {
    const candidates = this.getCandidates(group, ctx.chainId);

    let bestHandler: TransactionHandler | null = null;
    let bestScore = 0;

    for (const ext of candidates) {
      const handler = ext.handler;

      // Check chain support
      if (
        handler.supportedChainIds.length > 0 &&
        !handler.supportedChainIds.includes(ctx.chainId)
      ) {
        continue;
      }

      const score = handler.match(group, ctx);
      if (score > bestScore) {
        bestScore = score;
        bestHandler = handler;
      }
    }

    // Fallback to generic
    if (!bestHandler) {
      bestHandler = this.allExtensions.find(
        (e) => e.handler.id === "generic-etherscan",
      )?.handler ?? null;
    }

    return bestHandler!;
  }

  async processGroup(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult & { handlerId: string; warnings?: string[] }> {
    const handler = this.findBest(group, ctx);
    const warnings: string[] = [];

    // Global enrichment flag from context
    const enrichedCtx: HandlerContext = {
      ...ctx,
      enrichment: ctx.enrichment ?? false,
    };

    try {
      const result = await handler.process(group, enrichedCtx);
      return { ...result, handlerId: handler.id, warnings };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`handler ${handler.id} failed: ${msg}, falling back to generic`);

      if (handler.id !== "generic-etherscan") {
        const generic = this.allExtensions.find(
          (e) => e.handler.id === "generic-etherscan",
        );
        if (generic) {
          const result = await generic.handler.process(group, { ...ctx, enrichment: false });
          return { ...result, handlerId: "generic-etherscan", warnings };
        }
      }

      return {
        type: "skip",
        reason: `handler error: ${msg}`,
        handlerId: handler.id,
        warnings,
      };
    }
  }

  /**
   * Collect candidate extensions from index lookups + universal handlers.
   */
  private getCandidates(
    group: TxHashGroup,
    _chainId: number,
  ): Set<TransactionHandlerExtension> {
    const candidates = new Set<TransactionHandlerExtension>(this.universalHandlers);

    const addresses = this.extractAddresses(group);
    const symbols = this.extractSymbols(group);

    // Address exact match
    for (const addr of addresses) {
      const matches = this.addressIndex.get(addr);
      if (matches) {
        for (const ext of matches) candidates.add(ext);
      }
    }

    // Address prefix match
    for (const addr of addresses) {
      for (const { prefix, ext } of this.prefixIndex) {
        if (addr.startsWith(prefix)) {
          candidates.add(ext);
        }
      }
    }

    // Symbol exact match
    for (const sym of symbols) {
      const matches = this.symbolIndex.get(sym);
      if (matches) {
        for (const ext of matches) candidates.add(ext);
      }
    }

    // Symbol pattern match
    for (const sym of symbols) {
      for (const { pattern, ext } of this.patternIndex) {
        if (pattern.test(sym)) {
          candidates.add(ext);
        }
      }
    }

    return candidates;
  }

  /**
   * Extract all unique addresses from a transaction group (lowercase).
   */
  private extractAddresses(group: TxHashGroup): string[] {
    const addrs = new Set<string>();

    if (group.normal) {
      if (group.normal.to) addrs.add(group.normal.to.toLowerCase());
      if (group.normal.from) addrs.add(group.normal.from.toLowerCase());
    }
    for (const tx of group.internals) {
      if (tx.to) addrs.add(tx.to.toLowerCase());
      if (tx.from) addrs.add(tx.from.toLowerCase());
    }
    for (const tx of group.erc20s) {
      if (tx.to) addrs.add(tx.to.toLowerCase());
      if (tx.from) addrs.add(tx.from.toLowerCase());
      if (tx.contractAddress) addrs.add(tx.contractAddress.toLowerCase());
    }
    for (const tx of group.erc721s) {
      if (tx.to) addrs.add(tx.to.toLowerCase());
      if (tx.from) addrs.add(tx.from.toLowerCase());
      if (tx.contractAddress) addrs.add(tx.contractAddress.toLowerCase());
    }
    for (const tx of group.erc1155s) {
      if (tx.to) addrs.add(tx.to.toLowerCase());
      if (tx.from) addrs.add(tx.from.toLowerCase());
      if (tx.contractAddress) addrs.add(tx.contractAddress.toLowerCase());
    }

    return [...addrs];
  }

  /**
   * Extract all unique token symbols from ERC-20/721/1155 transfers (uppercase).
   */
  private extractSymbols(group: TxHashGroup): string[] {
    const syms = new Set<string>();

    for (const tx of group.erc20s) {
      if (tx.tokenSymbol) syms.add(tx.tokenSymbol.toUpperCase());
    }
    for (const tx of group.erc721s) {
      if (tx.tokenName) syms.add(tx.tokenName.toUpperCase());
    }
    for (const tx of group.erc1155s) {
      if (tx.tokenName) syms.add(tx.tokenName.toUpperCase());
    }

    return [...syms];
  }
}
