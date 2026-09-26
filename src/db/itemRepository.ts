import type { DatabaseSync } from 'node:sqlite';
import type { ItemStatus, NormalizedItem, PendingItem } from '../types.ts';

/** 같은 (feed_id, guid)가 이미 있으면 무시한다. 새로 저장되었으면 true. */
export function insertItemIfAbsent(
  db: DatabaseSync,
  feedId: number,
  item: NormalizedItem,
  status: ItemStatus,
): boolean {
  const { changes } = db
    .prepare(
      `INSERT OR IGNORE INTO items (feed_id, guid, title, link, published_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(feedId, item.guid, item.title, item.link, item.publishedAt, status);
  return changes > 0;
}

/** 활성 피드의 발송 대기 글을 오래된 순서로 반환한다. 날짜가 없는 글은 뒤로 보낸다. */
export function listPendingItems(db: DatabaseSync): PendingItem[] {
  return db
    .prepare(
      `SELECT i.id, i.feed_id AS feedId, f.name AS feedName, f.url AS feedUrl, f.webhook_url AS webhookUrl,
              i.title, i.link, i.published_at AS publishedAt
         FROM items i
         JOIN feeds f ON f.id = i.feed_id
        WHERE i.status = 'pending' AND f.enabled = 1
        ORDER BY i.published_at IS NULL, i.published_at, i.id`,
    )
    .all() as unknown as PendingItem[];
}

/** 피드의 가장 최근 글 (날짜 없는 글은 뒤로). 상태와 무관하게 조회한다. */
export function getLatestItem(
  db: DatabaseSync,
  feedId: number,
): Pick<NormalizedItem, 'title' | 'link' | 'publishedAt'> | undefined {
  return db
    .prepare(
      `SELECT title, link, published_at AS publishedAt
         FROM items
        WHERE feed_id = ?
        ORDER BY published_at IS NULL, published_at DESC, id DESC
        LIMIT 1`,
    )
    .get(feedId) as unknown as Pick<NormalizedItem, 'title' | 'link' | 'publishedAt'> | undefined;
}

export function markItemSent(db: DatabaseSync, itemId: number, now: string): void {
  db.prepare(`UPDATE items SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`).run(now, itemId);
}

/** 발송 실패를 기록하고 갱신된 status를 반환한다. 시도 횟수가 maxAttempts에 도달하면 failed가 된다. */
export function recordDeliveryFailure(
  db: DatabaseSync,
  itemId: number,
  error: string,
  maxAttempts: number,
): ItemStatus {
  const row = db
    .prepare(
      `UPDATE items
          SET attempts = attempts + 1,
              last_error = ?,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
        WHERE id = ?
    RETURNING status`,
    )
    .get(error, maxAttempts, itemId) as { status: ItemStatus };
  return row.status;
}

export function countPendingByFeed(db: DatabaseSync): Map<number, number> {
  const rows = db
    .prepare(`SELECT feed_id AS feedId, COUNT(*) AS count FROM items WHERE status = 'pending' GROUP BY feed_id`)
    .all() as unknown as { feedId: number; count: number }[];
  return new Map(rows.map((row) => [row.feedId, row.count]));
}
