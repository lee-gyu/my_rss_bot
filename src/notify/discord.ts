import type { DiscordChannelType, FetchLike, PendingItem, Sleep } from '../types.ts';

/** https://discord.com/developers/docs/resources/webhook#execute-webhook */
export interface DiscordMessage {
  content: string;
  /** forum 채널에 만들 포스트 제목. forum 채널 webhook은 이 값이 없으면 400을 반환하고, 일반 채널은 이 값이 있으면 400을 반환한다. */
  thread_name?: string;
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
const THREAD_NAME_LIMIT = 100;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * channel 예:
 *   **[GeekNews]** 게시물 제목
 *   https://example.com/post        ← Discord가 링크 미리보기를 붙인다
 *
 * forum 예: 글 제목이 포스트 제목이 되므로 본문에는 피드명과 링크만 넣는다.
 *   포스트 제목: 게시물 제목
 *   본문:        **[GeekNews]**
 *                https://example.com/post
 */
export function formatItemMessage(
  item: Pick<PendingItem, 'feedName' | 'feedUrl' | 'title' | 'link'>,
  channelType: DiscordChannelType,
): DiscordMessage {
  const header = `**[${escapeMarkdown(item.feedName ?? item.feedUrl)}]**`;
  const linkLine = item.link ? `\n${item.link}` : '';

  if (channelType === 'forum') {
    return { content: header + linkLine, thread_name: formatThreadName(item.title), allowed_mentions: { parse: [] } };
  }
  const title = truncate(escapeMarkdown(item.title ?? '(제목 없음)'), CONTENT_LIMIT - header.length - 1 - linkLine.length);
  return { content: `${header} ${title}${linkLine}`, allowed_mentions: { parse: [] } };
}

/** dry-run과 테스트 발송에서 보여 줄 메시지. forum이면 포스트 제목을 앞에 붙인다. */
export function previewMessage(message: DiscordMessage): string {
  if (message.thread_name === undefined) return message.content;
  return `[포스트 제목] ${message.thread_name}\n${message.content}`;
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

/** 포스트 제목은 마크다운을 렌더링하지 않고 한 줄로만 표시되므로 이스케이프 대신 공백만 정리한다. */
function formatThreadName(title: string | null): string {
  return truncate(title?.replace(/\s+/g, ' ').trim() || '(제목 없음)', THREAD_NAME_LIMIT);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? '' : `${text.slice(0, max - 1)}…`;
}
