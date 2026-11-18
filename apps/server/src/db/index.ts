import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, SQLInputValue>;

/**
 * Thin wrapper around node:sqlite. Synchronous on purpose: one process, one
 * file, WAL – every service call is a short transaction without awaits inside.
 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') {
      const dir = dirname(file);
      try {
        mkdirSync(dir, { recursive: true });
        accessSync(dir, constants.W_OK);
      } catch {
        const uid = process.getuid?.() ?? '?';
        throw new Error(
          `Datenverzeichnis ${dir} ist nicht beschreibbar (Prozess läuft als UID ${uid}). ` +
            `Auf dem Host z. B.: sudo chown -R ${uid}:${uid} <Pfad des Volumes>`,
        );
      }
    }
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  /** Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}
