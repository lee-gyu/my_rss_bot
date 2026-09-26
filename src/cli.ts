import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { isHttpUrl, loadConfig, type Config } from './config.ts';
import { openDatabase } from './db/connection.ts';
import { deleteFeed, findFeedByUrl, getFeed, insertFeed, listFeeds, setFeedEnabled } from './db/feedRepository.ts';
import { countPendingByFeed } from './db/itemRepository.ts';
import { fetchFeed } from './feed/fetchFeed.ts';
import { parseFeed } from './feed/parseFeed.ts';
import { saveFeedSnapshot } from './jobs/collect.ts';
import { errorMessage } from './lib/logger.ts';
import { scriptArgs } from './lib/scriptArgs.ts';

const USAGE = `사용법: pnpm feed <명령> [옵션]

명령:
  add <url> [--name 이름] [--webhook URL]   피드를 검증해 등록하고, 현재 글은 알림 없이 기록(baseline)
  list                                       등록된 피드 목록
  remove <id>                                피드와 수집 기록 삭제
  enable <id>                                피드 활성화
  disable <id>                               피드 비활성화 (수집·발송 중단)`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      webhook: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, arg] = positionals;

  if (values.help || command === undefined) {
    console.log(USAGE);
    if (command === undefined && !values.help) process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  try {
    switch (command) {
      case 'add':
        return await addFeed(db, config, requireArg(arg, '<url>'), values.name ?? null, values.webhook ?? null);
      case 'list':
        return printFeeds(db);
      case 'remove':
        return removeFeed(db, parseId(arg));
      case 'enable':
      case 'disable':
        return toggleFeed(db, parseId(arg), command === 'enable');
      default:
        throw new UsageError(`알 수 없는 명령: ${command}`);
    }
  } finally {
    db.close();
  }
}

async function addFeed(
  db: DatabaseSync,
  config: Config,
  url: string,
  name: string | null,
  webhookUrl: string | null,
): Promise<void> {
  if (!isHttpUrl(url)) throw new UsageError(`http(s) URL이 아닙니다: ${url}`);
  if (webhookUrl !== null && !isHttpUrl(webhookUrl)) throw new UsageError(`--webhook이 http(s) URL이 아닙니다.`);
  const existing = findFeedByUrl(db, url);
  if (existing) throw new UsageError(`이미 등록된 피드입니다: #${existing.id}`);

  // 등록 전에 실제로 가져와 파싱해 본다. 실패하면 등록하지 않는다.
  const fetched = await fetchFeed(
    { url, etag: null, lastModified: null },
    { fetch, timeoutMs: config.fetchTimeoutMs, userAgent: config.userAgent },
  );
  if (fetched.kind !== 'ok') throw new Error('피드 응답을 받지 못했습니다.');
  const parsed = await parseFeed(fetched.body);

  const feed = insertFeed(db, { url, name, webhookUrl });
  const { skipped } = saveFeedSnapshot(db, feed, parsed, fetched, {
    maxNewPerFeed: config.maxNewPerFeed,
    now: new Date().toISOString(),
  });

  const saved = getFeed(db, feed.id);
  console.log(`등록 완료: #${feed.id} ${saved?.name ?? url}`);
  console.log(`  기존 글 ${skipped}건을 알림 없이 기록했습니다. 이후 올라오는 글부터 공유됩니다.`);
  if (webhookUrl === null && config.defaultWebhookUrl === null) {
    console.warn('  경고: 피드 전용 webhook도 DISCORD_WEB_HOOK도 없어 새 글을 발송할 수 없습니다.');
  }
}

function printFeeds(db: DatabaseSync): void {
  const feeds = listFeeds(db);
  if (feeds.length === 0) {
    console.log('등록된 피드가 없습니다. `pnpm feed add <url>`로 추가하세요.');
    return;
  }
  const pending = countPendingByFeed(db);
  console.table(
    feeds.map((feed) => ({
      id: feed.id,
      name: feed.name ?? '',
      enabled: feed.enabled,
      webhook: feed.webhookUrl ? 'feed' : 'default',
      lastSuccess: feed.lastSuccessAt ?? '-',
      failures: feed.consecutiveFailures,
      pending: pending.get(feed.id) ?? 0,
      url: feed.url,
    })),
  );
  for (const feed of feeds) {
    if (feed.lastError) console.log(`#${feed.id} 최근 오류: ${feed.lastError}`);
  }
}

function removeFeed(db: DatabaseSync, id: number): void {
  const feed = getFeed(db, id);
  if (!feed || !deleteFeed(db, id)) throw new UsageError(`피드 #${id}를 찾을 수 없습니다.`);
  console.log(`삭제 완료: #${id} ${feed.name ?? feed.url}`);
}

function toggleFeed(db: DatabaseSync, id: number, enabled: boolean): void {
  if (!setFeedEnabled(db, id, enabled)) throw new UsageError(`피드 #${id}를 찾을 수 없습니다.`);
  console.log(`피드 #${id}를 ${enabled ? '활성화' : '비활성화'}했습니다.`);
}

function requireArg(value: string | undefined, label: string): string {
  if (value === undefined) throw new UsageError(`${label} 인자가 필요합니다.`);
  return value;
}

function parseId(value: string | undefined): number {
  const id = Number(requireArg(value, '<id>'));
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`올바른 피드 id가 아닙니다: ${value}`);
  return id;
}

main(scriptArgs()).catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`오류: ${err.message}\n\n${USAGE}`);
  } else {
    console.error(`오류: ${errorMessage(err)}`);
  }
  process.exitCode = 1;
});
