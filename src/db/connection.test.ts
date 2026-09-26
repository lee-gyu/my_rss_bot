import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase } from './connection.ts';

describe('openDatabase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'my_rss_bot-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('상위 디렉터리를 만들고, 다시 열어도 마이그레이션을 중복 적용하지 않는다', () => {
    const path = join(dir, 'nested', 'rss.db');

    const first = openDatabase(path);
    first.prepare("INSERT INTO feeds (url) VALUES ('https://example.com/feed')").run();
    first.close();

    const second = openDatabase(path);
    const version = second.prepare('PRAGMA user_version').get() as { user_version: number };
    const count = second.prepare('SELECT COUNT(*) AS n FROM feeds').get() as { n: number };
    const fk = second.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    second.close();

    assert.equal(version.user_version, 1);
    assert.equal(count.n, 1);
    assert.equal(fk.foreign_keys, 1);
  });
});
