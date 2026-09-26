import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { listPendingItems, markItemSent, recordDeliveryFailure } from '../db/itemRepository.ts';
import { errorMessage, feedLabel, logger } from '../lib/logger.ts';
import { formatItemMessage, postToDiscord } from '../notify/discord.ts';
import type { FetchLike, PendingItem, Sleep } from '../types.ts';

export interface DeliverDeps {
  db: DatabaseSync;
  config: Config;
  fetch: FetchLike;
  sleep: Sleep;
  now: () => Date;
  /** true면 발송하지 않고 메시지를 로그로만 출력하며 상태도 바꾸지 않는다. */
  dryRun: boolean;
}

export interface DeliverSummary {
  pending: number;
  sent: number;
  failed: number;
}

interface FeedDeliveryStats {
  label: string;
  channel: string;
  sent: number;
  failed: number;
}

/** 2단계: pending 글을 오래된 순서로 순차 발송한다. 실패한 글은 다음 실행에서 재시도된다. */
export async function deliverPending(deps: DeliverDeps): Promise<DeliverSummary> {
  const items = listPendingItems(deps.db);
  const summary: DeliverSummary = { pending: items.length, sent: 0, failed: 0 };
  const lastPostedAt = new Map<string, number>();
  const perFeed = new Map<number, FeedDeliveryStats>();

  for (const item of items) {
    const message = formatItemMessage(item);
    const webhookUrl = item.webhookUrl ?? deps.config.defaultWebhookUrl;
    // webhook URL에는 토큰이 들어 있어 로그에는 어느 쪽 webhook인지만 남긴다.
    const channel = item.webhookUrl ? '피드 전용 채널' : '기본 채널';

    if (deps.dryRun) {
      logger.info(`[dry-run] 글 #${item.id} (${webhookUrl ? channel : 'webhook 미설정'})\n${message.content}`);
      continue;
    }

    let stats = perFeed.get(item.feedId);
    if (!stats) {
      stats = { label: feedLabel({ id: item.feedId, name: item.feedName, url: item.feedUrl }), channel, sent: 0, failed: 0 };
      perFeed.set(item.feedId, stats);
    }

    try {
      if (!webhookUrl) throw new Error('webhook이 설정되지 않았습니다. (피드 webhook_url 또는 DISCORD_WEB_HOOK 필요)');

      const last = lastPostedAt.get(webhookUrl);
      if (last !== undefined) {
        const wait = last + deps.config.webhookIntervalMs - deps.now().getTime();
        if (wait > 0) await deps.sleep(wait);
      }

      try {
        await postToDiscord(webhookUrl, message, {
          fetch: deps.fetch,
          sleep: deps.sleep,
          timeoutMs: deps.config.webhookTimeoutMs,
        });
      } finally {
        lastPostedAt.set(webhookUrl, deps.now().getTime());
      }

      markItemSent(deps.db, item.id, deps.now().toISOString());
      summary.sent++;
      stats.sent++;
      logger.info(`글 #${item.id} 전송 (${channel}): ${describeItem(item)}`);
    } catch (err) {
      const reason = errorMessage(err);
      const status = recordDeliveryFailure(deps.db, item.id, reason, deps.config.maxDeliveryAttempts);
      summary.failed++;
      stats.failed++;
      const suffix = status === 'failed' ? ' — 최대 시도 횟수에 도달해 failed로 전환합니다.' : '';
      logger.warn(`글 #${item.id} 발송 실패 (${channel}): ${describeItem(item)} — ${reason}${suffix}`);
    }
  }

  for (const stats of perFeed.values()) {
    if (stats.failed === 0) {
      logger.info(`${stats.label}: ${stats.channel}에 ${stats.sent}건 전송됨`);
    } else {
      logger.warn(`${stats.label}: ${stats.channel}에 ${stats.sent}건 전송됨, ${stats.failed}건 실패`);
    }
  }
  return summary;
}

/** 예: `[GeekNews] 게시물 제목 https://example.com/post` */
function describeItem(item: PendingItem): string {
  const link = item.link ? ` ${item.link}` : '';
  return `[${item.feedName ?? item.feedUrl}] ${item.title ?? '(제목 없음)'}${link}`;
}
