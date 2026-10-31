// SQLite 저장 계층 (추상화). 오프라인 단일 유저의 계정 상태를 보관한다.
// 상태 전체를 하나의 스냅샷(JSON)으로 저장/조립한다. 세분화 테이블은 단계적으로 추가.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Store {
  getUser(accountId: string): any | null;
  putUser(accountId: string, snapshot: any): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export class SqliteStore implements Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        account_id TEXT PRIMARY KEY,
        snapshot   TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getUser(accountId: string): any | null {
    const row = this.db.prepare('SELECT snapshot FROM users WHERE account_id = ?').get(accountId) as
      | { snapshot: string }
      | undefined;
    return row ? JSON.parse(row.snapshot) : null;
  }

  putUser(accountId: string, snapshot: any): void {
    this.db
      .prepare('INSERT INTO users(account_id, snapshot, updated_at) VALUES(?,?,?) ' +
        'ON CONFLICT(account_id) DO UPDATE SET snapshot=excluded.snapshot, updated_at=excluded.updated_at')
      .run(accountId, JSON.stringify(snapshot), Date.now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
}
