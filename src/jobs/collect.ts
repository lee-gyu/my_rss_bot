import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import {
  listFeeds,
  recordFetchFailure,
  recordFetchNotModified,
  recordFetchSuccess,
} from '../db/feedRepository.ts';
import { insertItemIfAbsent } from '../db/itemRepository.ts';
import { transaction } from '../db/transaction.ts';
import { fetchFeed } from '../feed/fetchFeed.ts';
import { parseFeed, type ParsedFeed } from '../feed/parseFeed.ts';
import { errorMessage, feedLabel, logger } from '../lib/logger.ts';
import { mapLimit } from '../lib/mapLimit.ts';
import type { Feed, FetchLike, ItemStatus, NormalizedItem } from '../types.ts';

export interface CollectDeps {
  db: DatabaseSync;
  config: Config;
  fetch: FetchLike;
  now: () => Date;
}

export interface CollectSummary {
  feeds: number;
  notModified: number;
  failed: number;
  /** 이번 실행에서 발송 대기로 올린 새 글 수 */
  newItems: number;
}

export interface SnapshotResult {
  baseline: boolean;
  pending: number;
  skipped: number;
}

type FeedOutcome = { kind: 'not-modified' } | { kind: 'failed' } | ({ kind: 'updated' } & SnapshotResult);

/** 1단계: 활성 피드를 모두 가져와 새 글을 items에 저장한다. 피드별 실패는 기록만 하고 계속 진행한다. */
export async function collectFeeds(deps: CollectDeps): Promise<CollectSummary> {
  const feeds = listFeeds(deps.db, { enabledOnly: true });
  const outcomes = await mapLimit(feeds, deps.config.fetchConcurrency, (feed) => collectFeed(feed, deps));

  const summary: CollectSummary = { feeds: feeds.length, notModified: 0, failed: 0, newItems: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind === 'not-modified') summary.notModified++;
    else if (outcome.kind === 'failed') summary.failed++;
    else summary.newItems += outcome.pending;
  }
  return summary;
}

async function collectFeed(feed: Feed, deps: CollectDeps): Promise<FeedOutcome> {
  const label = feedLabel(feed);
  try {
    const fetched = await fetchFeed(feed, {
      fetch: deps.fetch,
      timeoutMs: deps.config.fetchTimeoutMs,
      userAgent: deps.config.userAgent,
    });
    if (fetched.kind === 'not-modified') {
      recordFetchNotModified(deps.db, feed.id, deps.now().toISOString());
      return { kind: 'not-modified' };
    }

    const parsed = await parseFeed(fetched.body);
    const result = saveFeedSnapshot(deps.db, feed, parsed, fetched, {
      maxNewPerFeed: deps.config.maxNewPerFeed,
      now: deps.now().toISOString(),
    });

    if (result.baseline) {
      logger.info(`${label}: 첫 수집이라 기존 글 ${result.skipped}건을 알림 없이 기록했습니다.`);
    } else if (result.skipped > 0) {
      logger.warn(
        `${label}: 새 글이 ${result.pending + result.skipped}건이라 최신 ${result.pending}건만 발송하고 ${result.skipped}건은 건너뜁니다.`,
      );
    } else if (result.pending > 0) {
      logger.info(`${label}: 새 글 ${result.pending}건`);
    }
    return { kind: 'updated', ...result };
  } catch (err) {
    const message = errorMessage(err);
    recordFetchFailure(deps.db, feed.id, message, deps.now().toISOString());
    logger.warn(`${label}: 수집 실패 — ${message}`);
    return { kind: 'failed' };
  }
}

/**
 * 파싱한 피드를 한 트랜잭션으로 저장한다.
 * - 첫 성공(lastSuccessAt === null)이면 모든 글을 skipped로 기록한다(baseline).
 * - 그 외에는 새 글을 최신순으로 maxNewPerFeed건까지 pending, 나머지는 skipped로 기록한다.
 */
export function saveFeedSnapshot(
  db: DatabaseSync,
  feed: Pick<Feed, 'id' | 'lastSuccessAt'>,
  parsed: ParsedFeed,
  fetched: { etag: string | null; lastModified: string | null },
  options: { maxNewPerFeed: number; now: string },
): SnapshotResult {
  return transaction(db, () => {
    const baseline = feed.lastSuccessAt === null;
    let pending = 0;
    let skipped = 0;

    for (const item of newestFirst(parsed.items)) {
      const status: ItemStatus = !baseline && pending < options.maxNewPerFeed ? 'pending' : 'skipped';
      if (!insertItemIfAbsent(db, feed.id, item, status)) continue;
      if (status === 'pending') pending++;
      else skipped++;
    }

    recordFetchSuccess(db, feed.id, {
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      title: parsed.title,
      now: options.now,
    });
    return { baseline, pending, skipped };
  });
}

/** 날짜 내림차순. 날짜가 없는 글은 피드 순서를 유지한 채 뒤로 보낸다. */
function newestFirst(items: readonly NormalizedItem[]): NormalizedItem[] {
  return items.toSorted((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}
