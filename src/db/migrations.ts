import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './transaction.ts';

/**
 * 인덱스 i의 SQL을 적용하면 PRAGMA user_version이 i + 1이 된다.
 * 이미 배포된 항목은 수정하지 말고 뒤에 새 항목을 추가할 것.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE feeds (
    id                   INTEGER PRIMARY KEY,
    url                  TEXT NOT NULL UNIQUE,
    name                 TEXT,
    webhook_url          TEXT,
    enabled              INTEGER NOT NULL DEFAULT 1,
    etag                 TEXT,
    last_modified        TEXT,
    last_checked_at      TEXT,
    last_success_at      TEXT,
    last_error           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE items (
    id           INTEGER PRIMARY KEY,
    feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    title        TEXT,
    link         TEXT,
    published_at TEXT,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sent_at      TEXT,
    UNIQUE (feed_id, guid)
  );

  CREATE INDEX items_pending ON items (published_at) WHERE status = 'pending';
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}
