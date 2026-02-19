import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "./types.js";

export class HandlerRegistry {
  private handlers: TransactionHandler[] = [];

  register(handler: TransactionHandler): void {
    this.handlers.push(handler);
  }

  getAll(): TransactionHandler[] {
    return [...this.handlers];
  }

  findBest(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): TransactionHandler {
    let bestHandler: TransactionHandler | null = null;
    let bestScore = 0;

    for (const handler of this.handlers) {
      // Only enabled handlers participate
      const config = ctx.settings.handlers[handler.id];
      if (!config?.enabled && handler.id !== "generic-etherscan") continue;

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

    // Fallback to generic (always registered)
    if (!bestHandler) {
      bestHandler = this.handlers.find((h) => h.id === "generic-etherscan")!;
    }

    return bestHandler;
  }

  async processGroup(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult & { handlerId: string; warnings?: string[] }> {
    const handler = this.findBest(group, ctx);
    const warnings: string[] = [];

    try {
      const result = await handler.process(group, ctx);
      return { ...result, handlerId: handler.id, warnings };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`handler ${handler.id} failed: ${msg}, falling back to generic`);

      // Fall back to generic handler
      if (handler.id !== "generic-etherscan") {
        const generic = this.handlers.find((h) => h.id === "generic-etherscan");
        if (generic) {
          const result = await generic.process(group, ctx);
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
}
