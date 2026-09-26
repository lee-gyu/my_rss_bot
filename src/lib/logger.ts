type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  if (level === 'INFO') console.log(line);
  else console.error(line);
}

export const logger = {
  info: (message: string) => write('INFO', message),
  warn: (message: string) => write('WARN', message),
  error: (message: string) => write('ERROR', message),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // fetch 실패는 원인(ENOTFOUND, 인증서 오류 등)이 cause에 들어 있다.
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}
