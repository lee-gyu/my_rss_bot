export type ItemStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/** webhook이 연결된 Discord 채널 종류. forum이면 글마다 새 포스트(스레드)를 만든다. */
export type DiscordChannelType = 'channel' | 'forum';

/** 전역 fetch와 호환되는 최소 시그니처. 테스트에서 가짜 구현을 주입하기 위해 사용한다. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Sleep = (ms: number) => Promise<void>;

export interface Feed {
  id: number;
  url: string;
  name: string | null;
  webhookUrl: string | null;
  enabled: boolean;
  etag: string | null;
  lastModified: string | null;
  lastCheckedAt: string | null;
  /** null이면 아직 baseline이 수행되지 않은 피드 */
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export interface NormalizedItem {
  guid: string;
  title: string | null;
  link: string | null;
  /** ISO 8601 UTC */
  publishedAt: string | null;
}

export interface PendingItem {
  id: number;
  feedId: number;
  feedName: string | null;
  feedUrl: string;
  webhookUrl: string | null;
  title: string | null;
  link: string | null;
  publishedAt: string | null;
}
