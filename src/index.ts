import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/connection.ts';
import { runOnce } from './jobs/runOnce.ts';
import { logger } from './lib/logger.ts';
import { scriptArgs } from './lib/scriptArgs.ts';

/** cron 진입점: 한 번 수집·발송하고 종료한다. 피드/발송 개별 실패는 로그만 남기고 exit 0. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: scriptArgs(),
    options: { 'dry-run': { type: 'boolean', default: false } },
  });

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  try {
    const startedAt = Date.now();
    const { collect, deliver } = await runOnce({
      db,
      config,
      fetch,
      sleep,
      now: () => new Date(),
      dryRun: values['dry-run'],
    });
    logger.info(
      `완료 (${Date.now() - startedAt}ms) — ` +
        `피드 ${collect.feeds}개 (변경 없음 ${collect.notModified}, 실패 ${collect.failed}), 새 글 ${collect.newItems}건 / ` +
        `발송 대기 ${deliver.pending}건 중 성공 ${deliver.sent}, 실패 ${deliver.failed}` +
        (values['dry-run'] ? ' [dry-run]' : ''),
    );
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  logger.error(`치명적 오류: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
