import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../types.ts';
import { decodeBody, fetchFeed } from './fetchFeed.ts';

const options = { timeoutMs: 1_000, userAgent: 'test-agent' };

describe('fetchFeed', () => {
  it('저장된 ETag/Last-Modified로 조건부 요청을 보내고 응답의 캐시 헤더를 돌려준다', async () => {
    let sent: Headers | undefined;
    const fetch: FetchLike = async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response('<rss/>', { headers: { etag: '"v2"', 'last-modified': 'Sat, 26 Sep 2026 00:00:00 GMT' } });
    };

    const result = await fetchFeed(
      { url: 'https://example.com/feed', etag: '"v1"', lastModified: 'Fri, 25 Sep 2026 00:00:00 GMT' },
      { ...options, fetch },
    );

    assert.equal(sent?.get('if-none-match'), '"v1"');
    assert.equal(sent?.get('if-modified-since'), 'Fri, 25 Sep 2026 00:00:00 GMT');
    assert.equal(sent?.get('user-agent'), 'test-agent');
    assert.deepEqual(result, {
      kind: 'ok',
      body: '<rss/>',
      etag: '"v2"',
      lastModified: 'Sat, 26 Sep 2026 00:00:00 GMT',
    });
  });

  it('304면 not-modified를 반환한다', async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 304 });
    const result = await fetchFeed({ url: 'https://example.com/feed', etag: '"v1"', lastModified: null }, { ...options, fetch });
    assert.deepEqual(result, { kind: 'not-modified' });
  });

  it('2xx/304가 아니면 예외를 던진다', async () => {
    const fetch: FetchLike = async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' });
    await assert.rejects(
      fetchFeed({ url: 'https://example.com/feed', etag: null, lastModified: null }, { ...options, fetch }),
      /HTTP 503 Service Unavailable/,
    );
  });
});

describe('decodeBody', () => {
  // "한글"의 EUC-KR 바이트
  const hangulEucKr = [0xc7, 0xd1, 0xb1, 0xdb];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('XML 선언의 encoding으로 EUC-KR을 디코딩한다', () => {
    const bytes = new Uint8Array([
      ...ascii('<?xml version="1.0" encoding="EUC-KR"?><title>'),
      ...hangulEucKr,
      ...ascii('</title>'),
    ]);
    assert.equal(decodeBody(bytes, 'text/xml'), '<?xml version="1.0" encoding="EUC-KR"?><title>한글</title>');
  });

  it('Content-Type의 charset을 XML 선언보다 우선한다', () => {
    const bytes = new Uint8Array([...ascii('<?xml version="1.0" encoding="UTF-8"?>'), ...hangulEucKr]);
    assert.equal(decodeBody(bytes, 'application/rss+xml; charset=euc-kr'), '<?xml version="1.0" encoding="UTF-8"?>한글');
  });

  it('charset 정보가 없거나 알 수 없으면 UTF-8로 디코딩한다', () => {
    const bytes = new TextEncoder().encode('<rss>한글</rss>');
    assert.equal(decodeBody(bytes, null), '<rss>한글</rss>');
    assert.equal(decodeBody(bytes, 'text/xml; charset=unknown-charset'), '<rss>한글</rss>');
  });
});
