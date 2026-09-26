import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFeed } from './parseFeed.ts';

describe('parseFeed', () => {
  it('RSS 2.0: guid 속성이 있어도 문자열 guid를 사용하고 날짜를 ISO로 정규화한다', async () => {
    const feed = await parseFeed(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel>
        <title>  Example   Blog </title>
        <item>
          <title>첫 글</title>
          <link>https://example.com/1</link>
          <guid isPermaLink="false">post-1</guid>
          <pubDate>Fri, 25 Sep 2026 09:00:00 +0900</pubDate>
        </item>
        <item>
          <title>guid 없는 글</title>
          <link>https://example.com/2</link>
        </item>
      </channel></rss>`);

    assert.equal(feed.title, 'Example Blog');
    assert.deepEqual(feed.items, [
      { guid: 'post-1', title: '첫 글', link: 'https://example.com/1', publishedAt: '2026-09-25T00:00:00.000Z' },
      { guid: 'https://example.com/2', title: 'guid 없는 글', link: 'https://example.com/2', publishedAt: null },
    ]);
  });

  it('Atom: entry id를 guid로, alternate 링크를 link로 사용한다', async () => {
    const feed = await parseFeed(`<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Feed</title>
        <entry>
          <id>urn:uuid:1234</id>
          <title>Atom 글</title>
          <link rel="alternate" href="https://example.com/atom/1"/>
          <published>2026-09-24T12:00:00Z</published>
        </entry>
      </feed>`);

    assert.equal(feed.title, 'Atom Feed');
    assert.deepEqual(feed.items, [
      { guid: 'urn:uuid:1234', title: 'Atom 글', link: 'https://example.com/atom/1', publishedAt: '2026-09-24T12:00:00.000Z' },
    ]);
  });

  it('guid와 link가 모두 없으면 제목+날짜 해시를 사용한다 (항상 같은 값)', async () => {
    const xml = `<rss version="2.0"><channel><title>t</title>
      <item><title>링크 없는 글</title><pubDate>Thu, 24 Sep 2026 00:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const [first] = (await parseFeed(xml)).items;
    const [second] = (await parseFeed(xml)).items;

    assert.match(first!.guid, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first!.guid, second!.guid);
  });

  it('RSS/Atom이 아니면 예외를 던진다', async () => {
    await assert.rejects(parseFeed('<html><body>not a feed</body></html>'));
  });
});
