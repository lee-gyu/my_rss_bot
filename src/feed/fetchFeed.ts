import type { Feed, FetchLike } from '../types.ts';

export type FetchFeedResult =
  | { kind: 'not-modified' }
  | { kind: 'ok'; body: string; etag: string | null; lastModified: string | null };

export interface FetchFeedOptions {
  fetch: FetchLike;
  timeoutMs: number;
  userAgent: string;
}

const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/** 저장된 ETag/Last-Modified로 조건부 GET을 보낸다. 2xx/304가 아니면 예외를 던진다. */
export async function fetchFeed(
  feed: Pick<Feed, 'url' | 'etag' | 'lastModified'>,
  options: FetchFeedOptions,
): Promise<FetchFeedResult> {
  const headers: Record<string, string> = { 'User-Agent': options.userAgent, Accept: ACCEPT };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;

  const res = await options.fetch(feed.url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (res.status === 304) return { kind: 'not-modified' };
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());

  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    kind: 'ok',
    body: decodeBody(bytes, res.headers.get('content-type')),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Content-Type 헤더 또는 XML 선언의 encoding을 따라 디코딩한다. (EUC-KR 피드 대응) */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetFromContentType(contentType) ?? charsetFromXmlDeclaration(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // 알 수 없는 charset 라벨이면 UTF-8로 시도한다.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function charsetFromContentType(contentType: string | null): string | null {
  return contentType?.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ?? null;
}

function charsetFromXmlDeclaration(bytes: Uint8Array): string | null {
  // XML 선언은 ASCII 범위이므로 앞부분만 latin1로 읽어도 충분하다.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  return head.match(/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i)?.[1] ?? null;
}
