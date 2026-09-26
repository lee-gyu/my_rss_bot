import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from './connection.ts';
import { insertFeed } from './feedRepository.ts';
import { getLatestItem, insertItemIfAbsent } from './itemRepository.ts';

describe('getLatestItem', () => {
  it('상태와 무관하게 가장 최근 날짜의 글을 반환하고, 날짜 없는 글은 뒤로 보낸다', () => {
    const db = openDatabase(':memory:');
    const feed = insertFeed(db, { url: 'https://example.com/feed', name: null, webhookUrl: null });
    const other = insertFeed(db, { url: 'https://example.com/other', name: null, webhookUrl: null });

    assert.equal(getLatestItem(db, feed.id), undefined);

    insertItemIfAbsent(db, feed.id, { guid: 'no-date', title: '날짜 없음', link: null, publishedAt: null }, 'pending');
    insertItemIfAbsent(db, feed.id, { guid: 'old', title: '예전 글', link: 'https://example.com/old', publishedAt: '2026-09-01T00:00:00.000Z' }, 'sent');
    insertItemIfAbsent(db, feed.id, { guid: 'new', title: '최신 글', link: 'https://example.com/new', publishedAt: '2026-09-20T00:00:00.000Z' }, 'skipped');
    insertItemIfAbsent(db, other.id, { guid: 'x', title: '다른 피드', link: null, publishedAt: '2026-09-30T00:00:00.000Z' }, 'pending');

    const latest = getLatestItem(db, feed.id);
    assert.equal(latest?.title, '최신 글');
    assert.equal(latest?.link, 'https://example.com/new');
    db.close();
  });
});
