declare module "sql.js" {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: (string | number | Uint8Array | null)[][];
  }

  export type SqlValue = string | number | Uint8Array | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export class Statement {
    bind(params?: BindParams): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, SqlValue>): Record<string, SqlValue>;
    free(): boolean;
    reset(): void;
  }

  export interface SqlJsConfig {
    locateFile?: (filename: string) => string;
    wasmBinary?: ArrayBuffer;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
