import type { DiscordChannelType } from './types.ts';

export interface Config {
  databasePath: string;
  /** 피드에 webhook_url이 없을 때 사용하는 기본 Discord Webhook */
  defaultWebhookUrl: string | null;
  /** webhook이 연결된 채널 종류. 피드 전용 webhook에도 같은 값을 적용한다. */
  channelType: DiscordChannelType;
  fetchTimeoutMs: number;
  fetchConcurrency: number;
  userAgent: string;
  /** 한 번의 실행에서 피드당 발송 대기(pending)로 올릴 최대 새 글 수. 초과분은 skipped 처리 */
  maxNewPerFeed: number;
  /** 발송 실패가 이 횟수에 도달하면 failed로 전환 */
  maxDeliveryAttempts: number;
  /** 같은 webhook으로 연속 발송할 때의 최소 간격 (Discord 채널당 분당 30건 제한 대응) */
  webhookIntervalMs: number;
  webhookTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const defaultWebhookUrl = env.DISCORD_WEB_HOOK?.trim() || null;
  if (defaultWebhookUrl !== null && !isHttpUrl(defaultWebhookUrl)) {
    throw new Error('DISCORD_WEB_HOOK은 http(s) URL이어야 합니다.');
  }
  const channelType = env.DISCORD_CHANNEL_TYPE?.trim() || 'channel';
  if (channelType !== 'channel' && channelType !== 'forum') {
    throw new Error(`DISCORD_CHANNEL_TYPE은 channel 또는 forum이어야 합니다: ${channelType}`);
  }

  return {
    databasePath: env.DATABASE_PATH?.trim() || './data/rss.db',
    defaultWebhookUrl,
    channelType,
    fetchTimeoutMs: 15_000,
    fetchConcurrency: 4,
    userAgent: 'my_rss_bot/1.0',
    maxNewPerFeed: 5,
    maxDeliveryAttempts: 5,
    webhookIntervalMs: 2_000,
    webhookTimeoutMs: 10_000,
  };
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
