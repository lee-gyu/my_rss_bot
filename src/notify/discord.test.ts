import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../types.ts';
import { formatItemMessage, postToDiscord, previewMessage, WebhookError } from './discord.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123/token';

describe('formatItemMessage (channel)', () => {
  it('피드명과 제목, 원문 링크를 포함하고 멘션을 비활성화한다', () => {
    const message = formatItemMessage({
      feedName: 'GeekNews',
      feedUrl: 'https://news.hada.io/rss/news',
      title: '새 글',
      link: 'https://example.com/a',
    }, 'channel');
    assert.deepEqual(message, {
      content: '**[GeekNews]** 새 글\nhttps://example.com/a',
      allowed_mentions: { parse: [] },
    });
  });

  it('피드명과 제목, 링크가 없으면 대체 표기를 쓴다', () => {
    const message = formatItemMessage({ feedName: null, feedUrl: 'https://example.com/feed', title: null, link: null }, 'channel');
    assert.equal(message.content, '**[https://example.com/feed]** (제목 없음)');
  });

  it('제목의 마크다운 문자를 이스케이프한다', () => {
    const message = formatItemMessage({
      feedName: 'my_blog',
      feedUrl: 'https://example.com/feed',
      title: '*굵게* _기울임_ ~~취소~~ `코드` ||스포일러|| [링크]',
      link: null,
    }, 'channel');
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
    }, 'channel');
    assert.equal(message.content.length, 2000);
    assert.ok(message.content.endsWith('…\nhttps://example.com/long'));
  });
});

describe('formatItemMessage (forum)', () => {
  it('제목을 포스트 제목(thread_name)으로 쓰고, 본문에는 피드명과 링크만 넣는다', () => {
    const message = formatItemMessage(
      { feedName: 'my_blog', feedUrl: 'https://example.com/feed', title: '새 글', link: 'https://example.com/a' },
      'forum',
    );
    assert.deepEqual(message, {
      content: '**[my\\_blog]**\nhttps://example.com/a',
      thread_name: '새 글',
      allowed_mentions: { parse: [] },
    });
  });

  it('포스트 제목은 마크다운을 이스케이프하지 않고, 줄바꿈과 연속 공백을 한 칸으로 정리한다', () => {
    const message = formatItemMessage(
      { feedName: 'Feed', feedUrl: 'https://example.com/feed', title: '  *굵게*\n\n  다음   줄 ', link: null },
      'forum',
    );
    assert.equal(message.thread_name, '*굵게* 다음 줄');
    assert.equal(message.content, '**[Feed]**');
  });

  it('포스트 제목을 100자로 자른다', () => {
    const message = formatItemMessage(
      { feedName: 'Feed', feedUrl: 'https://example.com/feed', title: '가'.repeat(300), link: null },
      'forum',
    );
    assert.equal(message.thread_name?.length, 100);
    assert.ok(message.thread_name?.endsWith('가…'));
  });

  it('제목이 없거나 공백뿐이면 (제목 없음)을 포스트 제목으로 쓴다', () => {
    for (const title of [null, '', ' \n ']) {
      const message = formatItemMessage({ feedName: null, feedUrl: 'https://example.com/feed', title, link: null }, 'forum');
      assert.equal(message.thread_name, '(제목 없음)');
      assert.equal(message.content, '**[https://example.com/feed]**');
    }
  });
});

describe('previewMessage', () => {
  it('forum 메시지는 포스트 제목을 앞에 붙이고, channel 메시지는 본문만 보여 준다', () => {
    const item = { feedName: 'Feed', feedUrl: 'https://example.com/feed', title: '새 글', link: 'https://example.com/a' };
    assert.equal(previewMessage(formatItemMessage(item, 'forum')), '[포스트 제목] 새 글\n**[Feed]**\nhttps://example.com/a');
    assert.equal(previewMessage(formatItemMessage(item, 'channel')), '**[Feed]** 새 글\nhttps://example.com/a');
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
