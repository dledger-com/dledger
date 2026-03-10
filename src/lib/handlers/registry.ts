import type {
  TransactionHandler,
  HandlerContext,
  HandlerResult,
  TxHashGroup,
} from "./types.js";
import { IndexedHandlerRegistry } from "../plugins/indexed-handler-registry.js";
import type { TransactionHandlerExtension } from "../plugins/types.js";

/**
 * HandlerRegistry — thin wrapper that delegates to IndexedHandlerRegistry.
 * Kept for backward compatibility; new code should use IndexedHandlerRegistry directly.
 */
export class HandlerRegistry {
  private indexed = new IndexedHandlerRegistry();

  register(handler: TransactionHandler): void {
    // Legacy register — no hints, so handler becomes universal
    this.indexed.register({ handler });
  }

  /** Register with hints for indexed matching. */
  registerExtension(ext: TransactionHandlerExtension): void {
    this.indexed.register(ext);
  }

  getAll(): TransactionHandler[] {
    return this.indexed.getAll();
  }

  findBest(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): TransactionHandler {
    return this.indexed.findBest(group, ctx);
  }

  async processGroup(
    group: TxHashGroup,
    ctx: HandlerContext,
  ): Promise<HandlerResult & { handlerId: string; warnings?: string[] }> {
    return this.indexed.processGroup(group, ctx);
  }
}
