/**
 * SQLite database adapter wrapping Node.js built-in `node:sqlite` (`DatabaseSync`).
 *
 * Provides a drop-in replacement for `better-sqlite3` without requiring native
 * C++ compilation (node-gyp, Python, Visual Studio build tools) on user machines.
 * Supported on Node.js >= 22.5.0 and Node.js 24+.
 */

import fs from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DatabaseOptions {
  readonly?: boolean;
  readOnly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: (message?: any, ...additionalArgs: any[]) => void;
  [key: string]: any;
}

function normalizeValue(val: any): any {
  if (val === undefined) {
    return null;
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  return val;
}

function normalizeParams(params: any[]): any[] {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0].map(normalizeValue);
  }
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Buffer.isBuffer(params[0]) &&
    !(params[0] instanceof Uint8Array)
  ) {
    const obj = params[0];
    const copy: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      copy[k] = normalizeValue(v);
    }
    return [copy];
  }
  return params.map(normalizeValue);
}

function normalizeRow<T = any>(row: any): T {
  if (!row || typeof row !== 'object') {
    return row;
  }
  const copy: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
      copy[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    } else {
      copy[k] = v;
    }
  }
  return copy as T;
}

export class Statement<T = any, _P = any> {
  private readonly rawStmt: StatementSync;

  constructor(rawStmt: StatementSync) {
    this.rawStmt = rawStmt;
  }

  run(...params: any[]): RunResult {
    const res = this.rawStmt.run(...normalizeParams(params));
    return {
      changes: Number(res.changes),
      lastInsertRowid: res.lastInsertRowid,
    };
  }

  get(...params: any[]): T | undefined {
    const row = this.rawStmt.get(...normalizeParams(params));
    if (!row) {
      return undefined;
    }
    return normalizeRow<T>(row);
  }

  all(...params: any[]): T[] {
    const rows = this.rawStmt.all(...normalizeParams(params));
    return rows.map((r) => normalizeRow<T>(r));
  }

  iterate(...params: any[]): IterableIterator<T> {
    const rows = this.all(...params);
    return rows[Symbol.iterator]();
  }
}

export class Database {
  private readonly rawDb: DatabaseSync;
  private inTransaction = false;

  constructor(filename: string, options?: DatabaseOptions) {
    const syncOptions: { readOnly?: boolean; open?: boolean } = {};

    if (options) {
      if (options.readonly || options.readOnly) {
        syncOptions.readOnly = true;
      }
      if (
        options.fileMustExist &&
        filename !== ':memory:' &&
        !filename.startsWith('file:') &&
        !fs.existsSync(filename)
      ) {
        throw new Error(`Cannot open database because the file does not exist: ${filename}`);
      }
    }

    this.rawDb = new DatabaseSync(filename, syncOptions);
  }

  exec(sql: string): this {
    this.rawDb.exec(sql);
    return this;
  }

  prepare<P = any, R = P>(sql: string): Statement<R, P> {
    const rawStmt = this.rawDb.prepare(sql);
    return new Statement<R, P>(rawStmt);
  }

  close(): void {
    this.rawDb.close();
  }

  pragma(pragmaSql: string, options?: { simple?: boolean }): any {
    const stmt = this.rawDb.prepare(`PRAGMA ${pragmaSql}`);
    if (options?.simple) {
      const row = stmt.get() as Record<string, any> | undefined;
      if (!row) return undefined;
      const values = Object.values(row);
      return values[0];
    }
    return stmt.all();
  }

  transaction<F extends (...args: any[]) => any>(fn: F): F {
    return ((...args: any[]) => {
      if (this.inTransaction) {
        const savepointName = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this.rawDb.exec(`SAVEPOINT ${savepointName}`);
        try {
          const result = fn(...args);
          this.rawDb.exec(`RELEASE SAVEPOINT ${savepointName}`);
          return result;
        } catch (error) {
          this.rawDb.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          throw error;
        }
      }

      this.inTransaction = true;
      this.rawDb.exec('BEGIN');
      try {
        const result = fn(...args);
        this.rawDb.exec('COMMIT');
        return result;
      } catch (error) {
        this.rawDb.exec('ROLLBACK');
        throw error;
      } finally {
        this.inTransaction = false;
      }
    }) as F;
  }
}

export namespace Database {
  export type Database = InstanceType<typeof Database>;
  export type Statement<T = any> = InstanceType<typeof import('./sqlite.js').Statement<T>>;
  export type RunResult = import('./sqlite.js').RunResult;
}

export default Database;
