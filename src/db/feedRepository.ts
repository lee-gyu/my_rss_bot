import type { DatabaseSync } from 'node:sqlite';
import type { Feed } from '../types.ts';

interface FeedRow {
  id: number;
  url: string;
  name: string | null;
  webhook_url: string | null;
  enabled: number;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_at: string;
}

function toFeed(row: FeedRow): Feed {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    webhookUrl: row.webhook_url,
    enabled: row.enabled === 1,
    etag: row.etag,
    lastModified: row.last_modified,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
  };
}

export function listFeeds(db: DatabaseSync, options: { enabledOnly?: boolean } = {}): Feed[] {
  const where = options.enabledOnly ? 'WHERE enabled = 1' : '';
  const rows = db.prepare(`SELECT * FROM feeds ${where} ORDER BY id`).all() as unknown as FeedRow[];
  return rows.map(toFeed);
}

export function getFeed(db: DatabaseSync, id: number): Feed | undefined {
  const row = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as unknown as FeedRow | undefined;
  return row && toFeed(row);
}

export function findFeedByUrl(db: DatabaseSync, url: string): Feed | undefined {
  const row = db.prepare('SELECT * FROM feeds WHERE url = ?').get(url) as unknown as FeedRow | undefined;
  return row && toFeed(row);
}

export function insertFeed(
  db: DatabaseSync,
  input: { url: string; name: string | null; webhookUrl: string | null },
): Feed {
  const row = db
    .prepare('INSERT INTO feeds (url, name, webhook_url) VALUES (?, ?, ?) RETURNING *')
    .get(input.url, input.name, input.webhookUrl) as unknown as FeedRow;
  return toFeed(row);
}

export function deleteFeed(db: DatabaseSync, id: number): boolean {
  return db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes > 0;
}

export function setFeedEnabled(db: DatabaseSync, id: number, enabled: boolean): boolean {
  return db.prepare('UPDATE feeds SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
}

export function recordFetchNotModified(db: DatabaseSync, feedId: number, now: string): void {
  db.prepare(
    `UPDATE feeds
        SET last_checked_at = ?, last_error = NULL, consecutive_failures = 0
      WHERE id = ?`,
  ).run(now, feedId);
}

export function recordFetchSuccess(
  db: DatabaseSync,
  feedId: number,
  result: { etag: string | null; lastModified: string | null; title: string | null; now: string },
): void {
  db.prepare(
    `UPDATE feeds
        SET etag = ?, last_modified = ?, name = COALESCE(name, ?),
            last_checked_at = ?, last_success_at = ?, last_error = NULL, consecutive_failures = 0
      WHERE id = ?`,
  ).run(result.etag, result.lastModified, result.title, result.now, result.now, feedId);
}

export function recordFetchFailure(db: DatabaseSync, feedId: number, error: string, now: string): void {
  db.prepare(
    `UPDATE feeds
        SET last_checked_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1
      WHERE id = ?`,
  ).run(now, error, feedId);
}
