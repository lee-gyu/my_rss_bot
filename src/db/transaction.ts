import type { DatabaseSync } from 'node:sqlite';

/**
 * fn을 하나의 트랜잭션으로 실행한다.
 * fn은 동기 함수여야 한다. await가 끼어들면 다른 비동기 작업의 쿼리가 트랜잭션에 섞인다.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
