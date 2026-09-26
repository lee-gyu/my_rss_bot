import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedLabel, formatTimestamp } from './logger.ts';

describe('formatTimestamp', () => {
  it('밀리초를 버리고 UTC로 표기한다', () => {
    assert.equal(formatTimestamp(new Date('2026-09-26T04:09:21.999Z')), '2026-09-26 04:09:21 UTC');
    // 시간대가 붙은 입력도 UTC로 환산한다.
    assert.equal(formatTimestamp(new Date('2026-09-26T09:10:11+09:00')), '2026-09-26 00:10:11 UTC');
  });
});

describe('feedLabel', () => {
  it('이름이 없으면 URL을 쓴다', () => {
    assert.equal(feedLabel({ id: 1, name: 'GeekNews', url: 'https://news.hada.io/rss/news' }), '피드 #1 (GeekNews)');
    assert.equal(feedLabel({ id: 2, name: null, url: 'https://example.com/feed' }), '피드 #2 (https://example.com/feed)');
  });
});
