import type { FetchLike, PendingItem, Sleep } from '../types.ts';

/** https://discord.com/developers/docs/resources/webhook#execute-webhook */
export interface DiscordMessage {
  content: string;
  /** 피드 제목에 @everyone 같은 문자열이 있어도 아무도 멘션되지 않도록 멘션 파싱을 끈다. */
  allowed_mentions: { parse: [] };
}

export interface PostOptions {
  fetch: FetchLike;
  sleep: Sleep;
  timeoutMs: number;
}

export class WebhookError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Discord webhook HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'WebhookError';
    this.status = status;
  }
}

const CONTENT_LIMIT = 2000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * 예:
 *   **[GeekNews]** 게시물 제목
 *   https://example.com/post        ← Discord가 링크 미리보기를 붙인다
 */
export function formatItemMessage(item: Pick<PendingItem, 'feedName' | 'feedUrl' | 'title' | 'link'>): DiscordMessage {
  const header = `**[${escapeMarkdown(item.feedName ?? item.feedUrl)}]** `;
  const linkLine = item.link ? `\n${item.link}` : '';
  const title = truncate(escapeMarkdown(item.title ?? '(제목 없음)'), CONTENT_LIMIT - header.length - linkLine.length);
  return { content: header + title + linkLine, allowed_mentions: { parse: [] } };
}

/** Webhook으로 메시지를 보낸다. 429는 retry_after만큼 기다린 뒤 한 번 재시도한다. */
export async function postToDiscord(webhookUrl: string, message: DiscordMessage, options: PostOptions): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await options.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = await res.text();
    if (res.ok) return; // 기본 응답은 204 No Content

    if (res.status === 429 && attempt === 1) {
      await options.sleep(retryAfterMs(body, res.headers.get('retry-after')));
      continue;
    }
    throw new WebhookError(res.status, body);
  }
}

/** Discord는 본문의 retry_after(초, 소수)가 헤더(정수 초)보다 정확하므로 먼저 본다. */
function retryAfterMs(body: string, header: string | null): number {
  const seconds = retryAfterFromBody(body) ?? (header === null ? NaN : Number(header));
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
}

function retryAfterFromBody(body: string): number | null {
  try {
    const value: unknown = JSON.parse(body)?.retry_after;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/** 제목이 굵게·기울임·스포일러 등으로 렌더링되지 않도록 Discord 마크다운 문자를 이스케이프한다. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]]/g, '\\$&');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? '' : `${text.slice(0, max - 1)}…`;
}
