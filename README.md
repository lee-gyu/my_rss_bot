# my_rss_bot

SQLite에 등록된 RSS/Atom 피드를 주기적으로 확인하고, 새 글을 Discord Webhook으로 공유하는 봇입니다.
cron이 1시간마다 한 번 실행하며, 실행할 때마다 수집과 발송을 끝내고 종료합니다.

## 요구 사항

- Node.js 24 이상: 내장 `node:sqlite`와 TypeScript 타입 스트리핑을 사용하므로 빌드 단계가 없습니다.
- pnpm (`mise.toml`에 버전이 고정되어 있습니다)

## 설치

```sh
pnpm install
cp .env.template .env   # DISCORD_WEB_HOOK에 기본 Discord Webhook URL 입력
```

| 환경 변수 | 설명 | 기본값 |
|---|---|---|
| `DISCORD_WEB_HOOK` | 피드에 전용 webhook이 없을 때 쓰는 기본 Webhook | 없음 |
| `DATABASE_PATH` | SQLite 파일 경로 | `./data/rss.db` |

## 피드 관리

```sh
pnpm feed add <url> [--name 이름] [--webhook URL]   # 검증 후 등록, 현재 글은 알림 없이 기록
pnpm feed list                                      # 목록 (마지막 성공 시각, 연속 실패, 발송 대기 수)
pnpm feed disable <id>                              # 수집·발송 중단
pnpm feed enable <id>
pnpm feed remove <id>                               # 피드와 수집 기록 삭제
```

`--webhook`을 지정하면 해당 피드의 글은 그 채널로 보내고, 지정하지 않으면 `DISCORD_WEB_HOOK`으로 보냅니다.
Webhook URL은 Discord 채널 설정 → 연동 → 웹후크에서 만들 수 있습니다(`https://discord.com/api/webhooks/<id>/<token>`).

## 실행

```sh
pnpm start             # 수집 + 발송 1회
pnpm start --dry-run   # 수집은 하되, 발송하지 않고 보낼 메시지를 로그로 출력 (pending 유지)
```

## 동작 방식

```
cron ─▶ src/index.ts ─▶ runOnce()
                         ├─ 1) collect: 활성 피드 조회 → 조건부 GET → 파싱 → items에 저장
                         └─ 2) deliver: status='pending' 글을 오래된 순서로 발송 → 'sent'
```

- **중복 방지:** `(feed_id, guid)`에 UNIQUE 제약을 두므로 같은 글은 한 번만 저장·발송됩니다. guid는 `guid` → `id`(Atom) → `link` → 제목+날짜 해시 순으로 정합니다.
- **첫 수집(baseline):** 등록 시점에 이미 있던 글은 `skipped`로 기록하고 알리지 않습니다.
- **폭주 방지:** 한 번에 새 글이 5건을 넘으면 최신 5건만 발송하고 나머지는 `skipped` 처리합니다.
- **재시도:** 발송에 실패한 글은 `pending`으로 남아 다음 실행 때 다시 보냅니다. 5회 실패하면 `failed`로 전환합니다.
- **장애 격리:** 한 피드의 수집이 실패해도 다른 피드는 계속 처리하며, 실패 내용은 `pnpm feed list`에서 확인할 수 있습니다.
- **요청 절약:** ETag/Last-Modified로 조건부 요청을 보내 변경 없는 피드는 304로 건너뜁니다. EUC-KR 피드도 자동으로 디코딩합니다.
- **메시지 형식:** `**[피드명]** 제목` 아래 줄에 원문 링크를 붙여 Discord가 미리보기를 만들게 합니다. 제목의 마크다운 문자는 이스케이프하고, `allowed_mentions`로 멘션을 막아 제목에 `@everyone`이 있어도 알림이 가지 않습니다. 2000자 제한에 맞춰 제목을 자릅니다.
- **rate limit 대응:** 같은 Webhook에는 2초 간격으로 보내고(Discord 채널당 분당 30건 제한), 429 응답이 오면 `retry_after`만큼 기다린 뒤 한 번 재시도합니다.

## Linux 서버 배포 (crontab)

```sh
mise which node   # cron은 PATH가 최소한이라 node 절대 경로가 필요합니다
mkdir -p logs
crontab -e
```

```cron
0 * * * * cd /opt/my_rss_bot && flock -n /tmp/my_rss_bot.lock /절대경로/node --env-file=.env src/index.ts >> logs/bot.log 2>&1
```

- `flock -n`은 이전 실행이 끝나지 않았으면 이번 실행을 건너뜁니다.
- 치명적 오류(설정, DB)가 나면 exit code 1로 끝납니다. 피드별 수집 실패와 발송 실패는 로그만 남깁니다.
- `logs/bot.log`는 logrotate에 등록하는 것을 권장합니다.

## 개발

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # node --test (in-memory SQLite + 가짜 fetch)
```

타입 스트리핑으로 실행하므로 상대 경로 import에는 `.ts` 확장자를 붙이고, 타입은 `import type`으로 가져옵니다. `enum`, `namespace`, 생성자 파라미터 프로퍼티는 쓸 수 없으며(`erasableSyntaxOnly`), 문자열 유니온을 사용합니다.

```
src/
├─ index.ts / cli.ts        # cron 진입점 / 피드 관리 CLI
├─ config.ts, types.ts
├─ db/                      # 연결, user_version 마이그레이션, 리포지토리
├─ feed/                    # fetchFeed(조건부 GET, 인코딩), parseFeed(정규화)
├─ notify/discord.ts        # 메시지 포맷, 발송, 429 재시도
├─ jobs/                    # collect → deliver, runOnce
└─ lib/                     # logger, mapLimit, scriptArgs
```
