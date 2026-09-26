import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { listPendingItems, markItemSent, recordDeliveryFailure } from '../db/itemRepository.ts';
import { errorMessage, logger } from '../lib/logger.ts';
import { formatItemMessage, postToDiscord } from '../notify/discord.ts';
import type { FetchLike, Sleep } from '../types.ts';

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

/** 2단계: pending 글을 오래된 순서로 순차 발송한다. 실패한 글은 다음 실행에서 재시도된다. */
export async function deliverPending(deps: DeliverDeps): Promise<DeliverSummary> {
  const items = listPendingItems(deps.db);
  const summary: DeliverSummary = { pending: items.length, sent: 0, failed: 0 };
  const lastPostedAt = new Map<string, number>();

  for (const item of items) {
    const message = formatItemMessage(item);
    const webhookUrl = item.webhookUrl ?? deps.config.defaultWebhookUrl;

    if (deps.dryRun) {
      logger.info(`[dry-run] 글 #${item.id} → ${webhookUrl ? 'webhook' : '(webhook 미설정)'}\n${message.content}`);
      continue;
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
    } catch (err) {
      const reason = errorMessage(err);
      const status = recordDeliveryFailure(deps.db, item.id, reason, deps.config.maxDeliveryAttempts);
      summary.failed++;
      const suffix = status === 'failed' ? ' — 최대 시도 횟수에 도달해 failed로 전환합니다.' : '';
      logger.warn(`글 #${item.id} 발송 실패: ${reason}${suffix}`);
    }
  }
  return summary;
}
