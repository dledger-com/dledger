import type { BlockchainSourceExtension } from "./types.js";
import { BLOCKCHAIN_CHAINS } from "../blockchain-registry.js";

/** Compiled version of a blockchain source extension with pre-compiled regex. */
export interface CompiledBlockchainSource extends BlockchainSourceExtension {
  compiledRegex: RegExp;
}

export class BlockchainSourceRegistry {
  private sources = new Map<string, CompiledBlockchainSource>();

  register(ext: BlockchainSourceExtension): void {
    const id = ext.chainId.toLowerCase();

    // Check collision with built-in chains
    if (BLOCKCHAIN_CHAINS.some(c => c.id === id)) {
      throw new Error(`Blockchain source "${id}" conflicts with a built-in chain.`);
    }

    if (this.sources.has(id)) {
      throw new Error(`Blockchain source "${id}" is already registered.`);
    }

    const compiledRegex = new RegExp(ext.addressRegex);

    this.sources.set(id, { ...ext, chainId: id, compiledRegex });
  }

  get(chainId: string): CompiledBlockchainSource | undefined {
    return this.sources.get(chainId.toLowerCase());
  }

  has(chainId: string): boolean {
    return this.sources.has(chainId.toLowerCase());
  }

  getAll(): CompiledBlockchainSource[] {
    return [...this.sources.values()];
  }
}
