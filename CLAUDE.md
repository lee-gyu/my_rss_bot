# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 개요

SQLite(`data/rss.db`)에 등록된 RSS/Atom 피드를 확인하고 새 글을 Discord Webhook으로 공유하는 봇입니다. 상주 프로세스가 아닙니다. cron이 1시간마다 `src/index.ts`를 실행하면 한 번 수집·발송하고 종료합니다. 운영 환경은 Linux 서버 crontab이며, 배포 방법은 README.md에 있습니다.

## 명령

```sh
pnpm start                 # 수집 + 발송 1회 (.env 필수: --env-file=.env)
pnpm start --dry-run       # 수집은 실제로 저장하고, 발송만 생략해 메시지를 로그로 출력
pnpm feed <add|list|remove|enable|disable|test> ...   # 피드 관리 CLI (src/cli.ts)
pnpm feed test [id] [--webhook URL]   # 실제 형식의 샘플 메시지 1건 발송 (items 상태 불변)
pnpm typecheck             # tsc (noEmit, 타입 검사 전용)
pnpm test                  # node --test "src/**/*.test.ts"

node --test src/jobs/runOnce.test.ts                            # 파일 하나
node --test --test-name-pattern="304" src/jobs/runOnce.test.ts  # 테스트 이름으로 필터

./linux-setup.sh [--schedule "<cron>"] [--uninstall]   # Linux 서버 crontab 등록/해제
```

- `linux-setup.sh`는 다시 실행해도 안전합니다. 줄 끝의 `# my_rss_bot: <프로젝트 경로>` 주석으로 자기 항목을 찾아 교체하므로, cron 명령 형식을 바꿀 때는 이 표식을 유지해야 합니다. cron에서는 mise shim이 동작하지 않아 node 절대 경로를 사용합니다.

- 빌드 단계, 린터, 포매터는 없습니다. 변경 후에는 `pnpm typecheck`와 `pnpm test`로 확인합니다.
- `pnpm test --test-name-pattern=...`은 필터가 적용되지 않으므로, 이름으로 거를 때는 위처럼 `node --test`를 직접 실행합니다.
- 환경 변수는 `DISCORD_WEB_HOOK`(기본 webhook)과 `DATABASE_PATH`(기본값 `./data/rss.db`) 두 개뿐입니다. 타임아웃, 동시성, 발송 간격, 재시도 횟수 같은 튜닝 값은 `src/config.ts`의 상수입니다.

## 런타임 제약 (Node 24 타입 스트리핑)

`.ts`를 Node가 직접 실행하므로 TypeScript 문법 중 지울 수 있는(erasable) 것만 씁니다.
- 상대 import에는 `.ts` 확장자를 붙이고, 타입은 `import type`으로 가져옵니다(`verbatimModuleSyntax`).
- `enum`, `namespace`, 생성자 파라미터 프로퍼티는 쓸 수 없습니다(`erasableSyntaxOnly`). 문자열 유니온을 쓰고, 클래스 필드는 명시적으로 선언합니다.
- DB는 내장 `node:sqlite`의 **동기** API(`DatabaseSync`)입니다. 외부 의존성은 `rss-parser` 하나뿐이고, HTTP 요청은 내장 `fetch`로 직접 합니다(rss-parser는 `parseString`만 사용).
- 사용자 메시지, 로그, 주석은 한국어로 작성합니다.

## 아키텍처

### 2단계 실행과 outbox 패턴
`jobs/runOnce.ts`는 `collect` → `deliver` 순서로 실행합니다. 두 단계는 `items` 테이블로만 연결되며, 이 테이블이 outbox 역할을 합니다.

1. **collect** (`jobs/collect.ts`): 활성 피드를 `mapLimit`로 병렬 fetch합니다(ETag/Last-Modified 조건부 GET). 파싱 결과는 `saveFeedSnapshot()`이 피드 단위 트랜잭션으로 `INSERT OR IGNORE`합니다. 중복은 `UNIQUE(feed_id, guid)` 제약으로 막습니다. 피드별 실패는 `feeds.last_error`와 `consecutive_failures`에 기록하고 다음 피드로 넘어갑니다.
2. **deliver** (`jobs/deliver.ts`): `status='pending'`인 글을 `published_at` 오름차순으로 **순차** 발송합니다. 같은 webhook에는 `webhookIntervalMs` 간격을 둡니다. 발송 대상은 활성 피드의 글뿐입니다.

### item 상태 머신 (`pending | sent | skipped | failed`)
- `feeds.last_success_at IS NULL`인 피드를 처음 수집하면 **baseline**으로 처리해 모든 글을 `skipped`로 기록합니다.
- 그 외에는 새 글을 최신순으로 `maxNewPerFeed`건까지 `pending`, 나머지는 `skipped`로 기록합니다(폭주 방지).
- 발송에 성공하면 `sent`가 됩니다. 실패하면 `attempts++` 하고 `pending`으로 남겨 다음 cron 실행에서 재시도하며, `maxDeliveryAttempts`에 도달하면 `failed`가 됩니다.
- `pnpm feed add`도 같은 `saveFeedSnapshot()`을 호출해 등록 즉시 baseline을 수행합니다. baseline과 폭주 방지 규칙을 바꿀 때는 이 함수 하나만 고치면 됩니다.

### 그 밖의 흐름
- **webhook 결정:** `feeds.webhook_url ?? DISCORD_WEB_HOOK` (deliver에서 결정).
- **guid 결정:** `guid` → Atom `id` → `link` → `sha256(title|publishedAt)` (`feed/parseFeed.ts`). 이 규칙을 바꾸면 기존 글이 새 글로 인식되어 재발송될 수 있습니다.
- **Discord 메시지** (`notify/discord.ts`): `content` 안에 `**[피드명]** 제목\n링크`를 넣습니다. `allowed_mentions: { parse: [] }`는 피드 제목의 `@everyone`이 실제 멘션이 되지 않게 막으므로 유지해야 합니다. 마크다운 이스케이프와 2000자 자르기도 여기서 처리합니다. 429 응답은 본문의 `retry_after`로 한 번 재시도합니다.
- **인코딩:** `feed/fetchFeed.ts`가 Content-Type 헤더 또는 XML 선언의 charset으로 디코딩합니다(EUC-KR 피드 대응).
- **종료 코드:** 설정·DB 같은 치명적 오류만 exit 1입니다. 피드 수집과 발송 실패는 로그만 남기고 exit 0입니다.

### 의존성 주입과 테스트
DI 컨테이너나 클래스 계층이 없습니다. `db`, `config`, `fetch`(`FetchLike`), `sleep`, `now`를 함수 인자로 넘깁니다. 테스트는 `openDatabase(':memory:')`와 가짜 `FetchLike`만으로 구성하고, mock 라이브러리는 쓰지 않습니다. 전체 흐름 시나리오(baseline, 중복, 재시도, 304, dry-run 등)는 `src/jobs/runOnce.test.ts`에 있으므로 동작을 바꾸면 여기에 시나리오를 추가합니다.

## 주의 사항

- **`transaction()`에 넘기는 함수는 동기여야 합니다** (`db/transaction.ts`). collect는 여러 피드를 병렬로 처리하므로 트랜잭션 안에 `await`가 들어가면 다른 피드의 쿼리가 섞입니다.
- **마이그레이션은 추가만 합니다.** `db/migrations.ts`의 `MIGRATIONS` 배열 인덱스가 `PRAGMA user_version`과 대응하므로, 이미 배포된 항목은 수정하지 말고 뒤에 새 항목을 추가합니다.
- **FK cascade는 연결마다 `PRAGMA foreign_keys=ON`이 필요합니다.** `openDatabase()`가 켜 주지만 외부 SQLite 도구는 기본값이 OFF라서, 그런 도구로 `feeds`를 삭제하면 `items`가 고아로 남습니다. 피드 삭제는 `pnpm feed remove`를 사용합니다.
- **`node:sqlite`의 행은 null-prototype 객체입니다.** 일반 객체 리터럴과 `assert.deepEqual`로 비교하면 실패하므로 필드 단위로 비교하거나 변환한 뒤 비교합니다. 리포지토리는 snake_case 행을 `as unknown as Row`로 캐스팅해 camelCase 도메인 객체로 변환합니다(`listPendingItems`는 SQL에서 별칭으로 처리).
- **시간은 ISO 8601 UTC 문자열로 저장합니다.** 정렬(`published_at`, `newestFirst`)이 문자열 사전순 비교에 의존합니다.
- **테스트에서 204 응답을 만들 때는 본문을 `null`로 둡니다.** `new Response('...', { status: 204 })`는 TypeError를 던집니다.
- **pnpm 인자 전달:** `pnpm start -- --dry-run`처럼 `--`가 붙어 들어오는 경우가 있어, 진입점에서는 `process.argv` 대신 `lib/scriptArgs.ts`를 사용합니다.
- **`feeds.webhook_url`에는 비밀 Discord webhook URL이 들어 있습니다.** 로그나 dry-run 출력에 URL을 찍지 않습니다.
