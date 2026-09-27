import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/connection.ts';
import { getFeed, insertFeed } from '../db/feedRepository.ts';
import type { DiscordChannelType, FetchLike } from '../types.ts';
import { runOnce } from './runOnce.ts';

const FEED_URL = 'https://example.com/feed.xml';
const DEFAULT_WEBHOOK = 'https://discord.com/api/webhooks/1/default-token';

interface Post {
  id: string;
  date: string;
}

function rss(posts: Post[], title = 'Example Blog'): string {
  const items = posts
    .map(
      (p) => `<item>
        <title>${p.id} 제목</title>
        <link>https://example.com/${p.id}</link>
        <guid>${p.id}</guid>
        <pubDate>${new Date(p.date).toUTCString()}</pubDate>
      </item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title>${items}</channel></rss>`;
}

const post = (id: string, day: number): Post => ({ id, date: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z` });

interface FakeFeed {
  status: number;
  xml: string;
  etag?: string;
}

describe('runOnce', () => {
  let db: DatabaseSync;
  let feeds: Map<string, FakeFeed>;
  let webhookStatus: number;
  let posts: { url: string; content: string; threadName: string | undefined }[];
  let feedRequests: { url: string; headers: Headers }[];
  let logs: string[];

  const fetch: FetchLike = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push({ url, content: body.content, threadName: body.thread_name });
      return new Response(webhookStatus === 204 ? null : 'error', { status: webhookStatus });
    }
    const headers = new Headers(init?.headers);
    feedRequests.push({ url, headers });
    const feed = feeds.get(url);
    if (!feed) return new Response('not found', { status: 404 });
    if (feed.etag && headers.get('if-none-match') === feed.etag) return new Response(null, { status: 304 });
    return new Response(feed.xml, {
      status: feed.status,
      headers: feed.etag ? { etag: feed.etag } : {},
    });
  };

  const run = (options: { dryRun?: boolean; channelType?: DiscordChannelType } = {}) =>
    runOnce({
      db,
      config: loadConfig({ DISCORD_WEB_HOOK: DEFAULT_WEBHOOK, DISCORD_CHANNEL_TYPE: options.channelType }),
      fetch,
      sleep: async () => {},
      now: () => new Date(),
      dryRun: options.dryRun ?? false,
    });

  const statuses = () =>
    Object.fromEntries(
      (db.prepare('SELECT guid, status FROM items ORDER BY guid').all() as { guid: string; status: string }[]).map(
        (row) => [row.guid, row.status],
      ),
    );

  const addFeed = (url = FEED_URL, webhookUrl: string | null = null) => insertFeed(db, { url, name: null, webhookUrl });

  beforeEach(() => {
    // 로그는 출력하지 않고 모아 둔다.
    logs = [];
    const capture = (line: unknown) => void logs.push(String(line));
    mock.method(console, 'log', capture);
    mock.method(console, 'error', capture);
    db = openDatabase(':memory:');
    feeds = new Map();
    webhookStatus = 204;
    posts = [];
    feedRequests = [];
  });

  afterEach(() => {
    db.close();
    mock.restoreAll();
  });

  it('첫 실행에서는 기존 글을 알림 없이 skipped로 기록하고 피드 제목을 이름으로 저장한다', async () => {
    const feed = addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1), post('b', 2)]) });

    const summary = await run();

    assert.equal(posts.length, 0);
    assert.deepEqual(statuses(), { a: 'skipped', b: 'skipped' });
    assert.equal(summary.collect.newItems, 0);
    assert.equal(getFeed(db, feed.id)?.name, 'Example Blog');
    assert.ok(getFeed(db, feed.id)?.lastSuccessAt);
  });

  it('baseline 이후 새 글만 오래된 순서로 한 번씩 발송한다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
    await run();

    feeds.set(FEED_URL, { status: 200, xml: rss([post('c', 3), post('b', 2), post('a', 1)]) });
    const summary = await run();

    assert.deepEqual(
      posts.map((p) => p.content),
      ['**[Example Blog]** b 제목\nhttps://example.com/b', '**[Example Blog]** c 제목\nhttps://example.com/c'],
    );
    assert.ok(posts.every((p) => p.url === DEFAULT_WEBHOOK));
    assert.ok(posts.every((p) => p.threadName === undefined), '일반 채널에는 thread_name을 보내면 안 된다');
    assert.deepEqual(summary.deliver, { pending: 2, sent: 2, failed: 0 });
    assert.deepEqual(statuses(), { a: 'skipped', b: 'sent', c: 'sent' });

    await run();
    assert.equal(posts.length, 2, '같은 글을 다시 발송하면 안 된다');
  });

  it('forum 타입이면 글마다 제목으로 새 포스트를 만들고, 본문에는 피드명과 링크를 넣는다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
    await run({ channelType: 'forum' });

    feeds.set(FEED_URL, { status: 200, xml: rss([post('c', 3), post('b', 2), post('a', 1)]) });
    const summary = await run({ channelType: 'forum' });

    assert.deepEqual(
      posts.map((p) => [p.threadName, p.content]),
      [
        ['b 제목', '**[Example Blog]**\nhttps://example.com/b'],
        ['c 제목', '**[Example Blog]**\nhttps://example.com/c'],
      ],
    );
    assert.deepEqual(summary.deliver, { pending: 2, sent: 2, failed: 0 });
    assert.deepEqual(statuses(), { a: 'skipped', b: 'sent', c: 'sent' });
  });

  it('forum 타입 dry-run은 포스트 제목과 본문을 로그로 출력한다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run({ channelType: 'forum' });
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
    logs = [];

    await run({ channelType: 'forum', dryRun: true });

    assert.equal(posts.length, 0);
    assert.ok(logs.some((line) => line.endsWith('[포스트 제목] a 제목\n**[Example Blog]**\nhttps://example.com/a')));
  });

  it('한 번에 새 글이 너무 많으면 최신 5건만 발송하고 나머지는 skipped 처리한다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('base', 1)]) });
    await run();

    const burst = Array.from({ length: 7 }, (_, i) => post(`n${i + 2}`, i + 2));
    feeds.set(FEED_URL, { status: 200, xml: rss(burst) });
    await run();

    assert.deepEqual(
      posts.map((p) => p.content.match(/\]\*\* (\S+) 제목/)?.[1]),
      ['n4', 'n5', 'n6', 'n7', 'n8'],
    );
    assert.equal(statuses().n2, 'skipped');
    assert.equal(statuses().n3, 'skipped');
  });

  it('피드 전용 webhook이 있으면 기본 webhook 대신 사용한다', async () => {
    const custom = 'https://discord.com/api/webhooks/2/custom-token';
    addFeed(FEED_URL, custom);
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run();

    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
    await run();

    assert.deepEqual(
      posts.map((p) => p.url),
      [custom],
    );
  });

  it('발송 실패는 다음 실행에 재시도하고, 최대 횟수에 도달하면 failed로 전환한다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });

    webhookStatus = 500;
    for (let i = 0; i < 5; i++) await run();

    assert.equal(posts.length, 5);
    assert.deepEqual(statuses(), { a: 'failed' });
    const row = db.prepare('SELECT attempts, last_error FROM items').get() as { attempts: number; last_error: string };
    assert.equal(row.attempts, 5);
    assert.match(row.last_error, /HTTP 500/);

    webhookStatus = 204;
    await run();
    assert.equal(posts.length, 5, 'failed 글은 더 이상 발송하지 않는다');
  });

  it('일시적 발송 실패 뒤 다음 실행에서 성공하면 sent가 된다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });

    webhookStatus = 503;
    await run();
    assert.deepEqual(statuses(), { a: 'pending' });

    webhookStatus = 204;
    await run();
    assert.deepEqual(statuses(), { a: 'sent' });
  });

  it('한 피드의 수집 실패를 기록하고 다른 피드는 계속 처리한다', async () => {
    const broken = addFeed('https://broken.example.com/feed');
    const healthy = addFeed(FEED_URL);
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });

    const summary = await run();

    assert.equal(summary.collect.failed, 1);
    assert.equal(getFeed(db, broken.id)?.consecutiveFailures, 1);
    assert.match(getFeed(db, broken.id)?.lastError ?? '', /HTTP 404/);
    assert.ok(getFeed(db, healthy.id)?.lastSuccessAt);
  });

  it('ETag가 같으면 304로 건너뛴다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]), etag: '"v1"' });
    await run();

    const summary = await run();

    assert.equal(feedRequests[1]?.headers.get('if-none-match'), '"v1"');
    assert.equal(summary.collect.notModified, 1);
  });

  it('비활성 피드는 수집하지 않고, 남은 pending도 발송하지 않는다', async () => {
    const feed = addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
    webhookStatus = 500;
    await run();

    db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?').run(feed.id);
    webhookStatus = 204;
    const requestsBefore = feedRequests.length;
    await run();

    assert.equal(feedRequests.length, requestsBefore);
    assert.deepEqual(statuses(), { a: 'pending' });
  });

  it('dry-run은 발송하지 않고 pending 상태를 유지한다', async () => {
    addFeed();
    feeds.set(FEED_URL, { status: 200, xml: rss([]) });
    await run();
    feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });

    await run({ dryRun: true });

    assert.equal(posts.length, 0);
    assert.deepEqual(statuses(), { a: 'pending' });
  });

  describe('로그', () => {
    // 시각(`2026-09-26 04:09:21 UTC`)과 레벨을 뗀 메시지
    const messages = () => logs.map((line) => line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC (INFO|WARN|ERROR) /, '$1 '));

    it('모든 줄이 UTC 시각으로 시작한다', async () => {
      addFeed();
      feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
      await run();

      assert.ok(logs.length > 0);
      for (const line of logs) assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC (INFO|WARN|ERROR) /);
    });

    it('전송한 글마다 한 줄, 피드별로 전송 건수를 남긴다', async () => {
      addFeed();
      feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
      await run();
      feeds.set(FEED_URL, { status: 200, xml: rss([post('c', 3), post('b', 2), post('a', 1)]) });
      logs = [];

      await run();

      const lines = messages().filter((m) => !m.includes('완료'));
      assert.equal(lines[0], 'INFO 피드 #1 (Example Blog): 새 글 2건');
      assert.match(lines[1]!, /^INFO 글 #\d+ 전송 \(기본 채널\): \[Example Blog\] b 제목 https:\/\/example\.com\/b$/);
      assert.match(lines[2]!, /^INFO 글 #\d+ 전송 \(기본 채널\): \[Example Blog\] c 제목 https:\/\/example\.com\/c$/);
      assert.equal(lines[3], 'INFO 피드 #1 (Example Blog): 기본 채널에 2건 전송됨');
      assert.equal(lines.length, 4);
    });

    it('발송 실패는 WARN으로 글 정보와 이유를 남기고, 피드 요약에 실패 건수를 붙인다', async () => {
      addFeed(FEED_URL, 'https://discord.com/api/webhooks/2/custom-token');
      feeds.set(FEED_URL, { status: 200, xml: rss([]) });
      await run();
      feeds.set(FEED_URL, { status: 200, xml: rss([post('a', 1)]) });
      webhookStatus = 500;
      logs = [];

      await run();

      const lines = messages();
      assert.ok(
        lines.some((m) =>
          /^WARN 글 #\d+ 발송 실패 \(피드 전용 채널\): \[Example Blog\] a 제목 https:\/\/example\.com\/a — Discord webhook HTTP 500/.test(m),
        ),
      );
      assert.ok(lines.includes('WARN 피드 #1 (Example Blog): 피드 전용 채널에 0건 전송됨, 1건 실패'));
      assert.ok(logs.every((line) => !line.includes('custom-token')), 'webhook 토큰이 로그에 남으면 안 된다');
    });
  });
});
