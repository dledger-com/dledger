declare module "wa-sqlite/src/examples/IDBBatchAtomicVFS.js" {
  export class IDBBatchAtomicVFS {
    constructor(idbDatabaseName?: string, options?: Record<string, unknown>);
  }
}

declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const factory: () => Promise<unknown>;
  export default factory;
}
