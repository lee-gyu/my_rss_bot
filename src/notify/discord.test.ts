import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../types.ts';
import { formatItemMessage, postToDiscord, WebhookError } from './discord.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123/token';

describe('formatItemMessage', () => {
  it('피드명과 제목, 원문 링크를 포함하고 멘션을 비활성화한다', () => {
    const message = formatItemMessage({
      feedName: 'GeekNews',
      feedUrl: 'https://news.hada.io/rss/news',
      title: '새 글',
      link: 'https://example.com/a',
    });
    assert.deepEqual(message, {
      content: '**[GeekNews]** 새 글\nhttps://example.com/a',
      allowed_mentions: { parse: [] },
    });
  });

  it('피드명과 제목, 링크가 없으면 대체 표기를 쓴다', () => {
    const message = formatItemMessage({ feedName: null, feedUrl: 'https://example.com/feed', title: null, link: null });
    assert.equal(message.content, '**[https://example.com/feed]** (제목 없음)');
  });

  it('제목의 마크다운 문자를 이스케이프한다', () => {
    const message = formatItemMessage({
      feedName: 'my_blog',
      feedUrl: 'https://example.com/feed',
      title: '*굵게* _기울임_ ~~취소~~ `코드` ||스포일러|| [링크]',
      link: null,
    });
    assert.equal(
      message.content,
      '**[my\\_blog]** \\*굵게\\* \\_기울임\\_ \\~\\~취소\\~\\~ \\`코드\\` \\|\\|스포일러\\|\\| \\[링크\\]',
    );
  });

  it('2000자를 넘지 않도록 제목을 자르고 링크는 보존한다', () => {
    const message = formatItemMessage({
      feedName: 'Feed',
      feedUrl: 'https://example.com/feed',
      title: '가'.repeat(5000),
      link: 'https://example.com/long',
    });
    assert.equal(message.content.length, 2000);
    assert.ok(message.content.endsWith('…\nhttps://example.com/long'));
  });
});

describe('postToDiscord', () => {
  function fakeFetch(responses: Response[]) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const res = responses.shift();
      assert.ok(res, '예상보다 많은 요청');
      return res;
    };
    return { fetch, calls };
  }

  const message = { content: 'hello', allowed_mentions: { parse: [] as [] } };

  it('JSON 본문으로 POST하고 204를 성공으로 처리한다', async () => {
    const { fetch, calls } = fakeFetch([new Response(null, { status: 204 })]);
    await postToDiscord(WEBHOOK, message, { fetch, sleep: async () => {}, timeoutMs: 1_000 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, WEBHOOK);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.body, JSON.stringify(message));
  });

  it('429면 본문의 retry_after만큼 기다린 뒤 한 번 재시도한다', async () => {
    const { fetch, calls } = fakeFetch([
      new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 1.5, global: false }), {
        status: 429,
        headers: { 'retry-after': '2' },
      }),
      new Response(null, { status: 204 }),
    ]);
    const sleeps: number[] = [];
    await postToDiscord(WEBHOOK, message, { fetch, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 1_000 });

    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [1_500]);
  });

  it('본문에 retry_after가 없으면 Retry-After 헤더를 쓴다', async () => {
    const { fetch } = fakeFetch([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } }),
      new Response(null, { status: 204 }),
    ]);
    const sleeps: number[] = [];
    await postToDiscord(WEBHOOK, message, { fetch, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 1_000 });

    assert.deepEqual(sleeps, [3_000]);
  });

  it('재시도에도 429거나 다른 오류면 WebhookError를 던진다', async () => {
    const twice429 = fakeFetch([new Response('', { status: 429 }), new Response('', { status: 429 })]);
    await assert.rejects(
      postToDiscord(WEBHOOK, message, { fetch: twice429.fetch, sleep: async () => {}, timeoutMs: 1_000 }),
      (err: unknown) => err instanceof WebhookError && err.status === 429,
    );

    const unknownWebhook = fakeFetch([new Response('{"message": "Unknown Webhook", "code": 10015}', { status: 404 })]);
    await assert.rejects(
      postToDiscord(WEBHOOK, message, { fetch: unknownWebhook.fetch, sleep: async () => {}, timeoutMs: 1_000 }),
      (err: unknown) => err instanceof WebhookError && err.status === 404,
    );
    assert.equal(unknownWebhook.calls.length, 1);
  });
});
