type Level = 'INFO' | 'WARN' | 'ERROR';

/** 로그 시각은 서버 시간대와 무관하게 UTC로 남긴다. 예: `2026-09-26 04:09:21 UTC` */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function write(level: Level, message: string): void {
  const line = `${formatTimestamp(new Date())} ${level} ${message}`;
  if (level === 'INFO') console.log(line);
  else console.error(line);
}

export const logger = {
  info: (message: string) => write('INFO', message),
  warn: (message: string) => write('WARN', message),
  error: (message: string) => write('ERROR', message),
};

/** 예: `피드 #1 (GeekNews)` */
export function feedLabel(feed: { id: number; name: string | null; url: string }): string {
  return `피드 #${feed.id} (${feed.name ?? feed.url})`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // fetch 실패는 원인(ENOTFOUND, 인증서 오류 등)이 cause에 들어 있다.
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}
