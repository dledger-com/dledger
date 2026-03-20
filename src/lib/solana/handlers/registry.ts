import type { HandlerResult } from "../../handlers/types.js";
import type { SolTxGroup } from "../types.js";
import type { SolanaHandler, SolanaHandlerContext } from "./types.js";

/**
 * Registry for Solana transaction handlers, indexed by programId for fast lookup.
 */
export class SolanaHandlerRegistry {
  private byProgramId = new Map<string, SolanaHandler[]>();
  private universalHandlers: SolanaHandler[] = [];
  private allHandlers: SolanaHandler[] = [];

  /**
   * Register a handler.
   * @param handler The handler to register
   * @param programIds Optional programIds to index by. If empty, handler is universal (always a candidate).
   */
  register(handler: SolanaHandler, programIds?: string[]): void {
    this.allHandlers.push(handler);
    if (!programIds || programIds.length === 0) {
      this.universalHandlers.push(handler);
      return;
    }
    for (const pid of programIds) {
      const existing = this.byProgramId.get(pid);
      if (existing) {
        existing.push(handler);
      } else {
        this.byProgramId.set(pid, [handler]);
      }
    }
  }

  /**
   * Extract all program IDs referenced in a transaction.
   */
  private extractProgramIds(tx: SolTxGroup): Set<string> {
    const ids = new Set<string>();
    for (const ix of tx.instructions) {
      ids.add(ix.programId);
      if (ix.innerInstructions) {
        for (const inner of ix.innerInstructions) {
          ids.add(inner.programId);
        }
      }
    }
    return ids;
  }

  /**
   * Get candidate handlers for a transaction.
   */
  getCandidates(tx: SolTxGroup): SolanaHandler[] {
    const programIds = this.extractProgramIds(tx);
    const candidates = new Set<SolanaHandler>(this.universalHandlers);
    for (const pid of programIds) {
      const handlers = this.byProgramId.get(pid);
      if (handlers) {
        for (const h of handlers) candidates.add(h);
      }
    }
    return Array.from(candidates);
  }

  /**
   * Find the best-scoring handler for a transaction.
   */
  findBest(tx: SolTxGroup, ctx: SolanaHandlerContext): SolanaHandler | null {
    const candidates = this.getCandidates(tx);
    let best: SolanaHandler | null = null;
    let bestScore = 0;
    for (const handler of candidates) {
      const score = handler.match(tx, ctx);
      if (score > bestScore) {
        bestScore = score;
        best = handler;
      }
    }
    return best;
  }

  /**
   * Process a transaction: find best handler, run it.
   * Falls back to generic handler on error.
   */
  async processTransaction(
    tx: SolTxGroup,
    ctx: SolanaHandlerContext,
  ): Promise<{ handler: SolanaHandler; result: HandlerResult } | null> {
    const best = this.findBest(tx, ctx);
    if (!best) return null;

    try {
      const result = await best.process(tx, ctx);
      return { handler: best, result };
    } catch (e) {
      // If best handler is not generic, try falling back to generic
      const generic = this.allHandlers.find(h => h.id === "generic-solana");
      if (generic && generic !== best) {
        try {
          const result = await generic.process(tx, ctx);
          return { handler: generic, result };
        } catch {
          return {
            handler: best,
            result: { type: "skip", reason: `Handler error: ${e instanceof Error ? e.message : String(e)}` },
          };
        }
      }
      return {
        handler: best,
        result: { type: "skip", reason: `Handler error: ${e instanceof Error ? e.message : String(e)}` },
      };
    }
  }

  getAll(): SolanaHandler[] {
    return [...this.allHandlers];
  }
}
