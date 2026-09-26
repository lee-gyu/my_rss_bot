import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import type { NormalizedItem } from '../types.ts';

export interface ParsedFeed {
  title: string | null;
  items: NormalizedItem[];
}

const parser = new Parser();

/** RSS 2.0 / RSS 1.0 / Atom XML을 파싱해 정규화된 글 목록으로 바꾼다. */
export async function parseFeed(xml: string): Promise<ParsedFeed> {
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    // xml2js 오류는 "Unexpected close tag\nLine: 0\n..."처럼 여러 줄이라 첫 줄만 남긴다.
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(`RSS/Atom 피드로 파싱할 수 없습니다: ${reason}`);
  }
  return {
    title: text(feed.title),
    items: feed.items.map(normalizeItem),
  };
}

function normalizeItem(item: Parser.Item & { id?: unknown }): NormalizedItem {
  const title = text(item.title);
  const link = text(item.link);
  const publishedAt = toIsoDate(item.isoDate ?? item.pubDate);
  // guid(RSS) → id(Atom) → link → 제목+날짜 해시 순으로 글을 식별한다.
  const guid = text(item.guid) ?? text(item.id) ?? link ?? sha256(`${title ?? ''}|${publishedAt ?? ''}`);
  return { guid, title, link, publishedAt };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
