#!/usr/bin/env bash
# my_rss_bot을 현재 사용자의 crontab에 등록한다.
# 다시 실행하면 이 디렉터리의 기존 항목을 교체하므로 node 업그레이드나 일정 변경 뒤에 재실행하면 된다.
#
# 사용법:
#   ./linux-setup.sh                              매시 정각(0 * * * *)으로 등록
#   ./linux-setup.sh --schedule "*/30 * * * *"    실행 주기 지정
#   ./linux-setup.sh --uninstall                  등록 해제
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER="# my_rss_bot: ${PROJECT_DIR}"
REQUIRED_NODE_MAJOR=24
SCHEDULE="0 * * * *"
UNINSTALL=false

info() { printf '==> %s\n' "$*"; }
warn() { printf '경고: %s\n' "$*" >&2; }
die() {
  printf '오류: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '5,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schedule)
      [[ $# -ge 2 ]] || die "--schedule에 cron 표현식이 필요합니다."
      SCHEDULE="$2"
      shift 2
      ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "알 수 없는 옵션: $1" ;;
  esac
done

current_crontab() { crontab -l 2>/dev/null || true; }

# crontab 전체에서 이 디렉터리의 항목만 뺀 내용
crontab_without_entry() {
  local current
  current="$(current_crontab)"
  [[ -n "$current" ]] || return 0
  printf '%s\n' "$current" | { grep -vF -- "$MARKER" || true; }
}

install_crontab() {
  local content="$1"
  if [[ -z "$content" ]]; then
    printf '' | crontab -
  else
    printf '%s\n' "$content" | crontab -
  fi
}

command -v crontab >/dev/null 2>&1 ||
  die "crontab이 없습니다. cron을 설치하세요. (Debian/Ubuntu: sudo apt install cron / RHEL 계열: sudo dnf install cronie)"
[[ "$(uname -s)" == "Linux" ]] || warn "Linux용 스크립트입니다. ($(uname -s)에서 실행 중)"

# ---------------------------------------------------------------- 등록 해제
if [[ "$UNINSTALL" == true ]]; then
  if ! grep -qF -- "$MARKER" <<<"$(current_crontab)"; then
    info "등록된 항목이 없습니다."
    exit 0
  fi
  install_crontab "$(crontab_without_entry)"
  info "crontab에서 my_rss_bot 항목을 제거했습니다. (${PROJECT_DIR})"
  exit 0
fi

# ---------------------------------------------------------------- 일정 검증
read -r -a schedule_fields <<<"$SCHEDULE"
if [[ "$SCHEDULE" != @* && ${#schedule_fields[@]} -ne 5 ]]; then
  die "cron 표현식은 5개 필드여야 합니다: '${SCHEDULE}'"
fi

cd "$PROJECT_DIR"

# ---------------------------------------------------------------- node
# cron의 PATH에는 mise shim이 없으므로 실제 node 실행 파일의 절대 경로가 필요하다.
NODE_BIN=""
if command -v mise >/dev/null 2>&1; then
  NODE_BIN="$(mise which node 2>/dev/null || true)"
fi
[[ -n "$NODE_BIN" ]] || NODE_BIN="$(command -v node 2>/dev/null || true)"
[[ -n "$NODE_BIN" ]] || die "node를 찾을 수 없습니다. Node.js ${REQUIRED_NODE_MAJOR} 이상을 설치하세요. (mise 사용 시: mise trust && mise install)"
[[ "$NODE_BIN" != */shims/* ]] ||
  die "node 경로가 mise shim입니다(${NODE_BIN}). cron에서는 동작하지 않으니 'mise trust && mise install' 후 다시 실행하세요."

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
((NODE_MAJOR >= REQUIRED_NODE_MAJOR)) ||
  die "Node.js ${REQUIRED_NODE_MAJOR} 이상이 필요합니다. (현재 $("$NODE_BIN" --version), ${NODE_BIN})"
info "node: ${NODE_BIN} ($("$NODE_BIN" --version))"

# ---------------------------------------------------------------- 의존성
if [[ ! -d node_modules/rss-parser ]]; then
  command -v pnpm >/dev/null 2>&1 ||
    die "의존성이 설치되어 있지 않고 pnpm도 없습니다. 'mise install' 또는 'corepack enable' 후 다시 실행하세요."
  info "의존성 설치: pnpm install --prod --frozen-lockfile"
  pnpm install --prod --frozen-lockfile
fi

# ---------------------------------------------------------------- .env
if [[ ! -f .env ]]; then
  cp .env.template .env
  warn ".env가 없어 .env.template으로 만들었습니다. DISCORD_WEB_HOOK을 입력하세요."
fi
chmod 600 .env # webhook URL(비밀값)이 들어 있다.
if ! grep -qE '^DISCORD_WEB_HOOK=.+' .env; then
  warn "DISCORD_WEB_HOOK이 비어 있습니다. 피드 전용 webhook(--webhook)이 없는 피드의 글은 발송에 실패합니다."
fi

mkdir -p logs data

# ---------------------------------------------------------------- 동작 확인
# DB를 열어(필요하면 마이그레이션) 등록된 피드를 출력한다. 네트워크 요청이나 발송은 하지 않는다.
info "DB 확인: node src/cli.ts list"
"$NODE_BIN" --env-file=.env src/cli.ts list || die "DB를 열 수 없습니다. 위 오류를 확인하세요."

# ---------------------------------------------------------------- crontab 등록
LOCK=""
if command -v flock >/dev/null 2>&1; then
  LOCK="$(command -v flock) -n $(printf '%q' "${PROJECT_DIR}/data/cron.lock") "
else
  warn "flock이 없어 중복 실행 방지 없이 등록합니다. (util-linux 패키지)"
fi

COMMAND="cd $(printf '%q' "$PROJECT_DIR") && ${LOCK}$(printf '%q' "$NODE_BIN") --env-file=.env src/index.ts >> $(printf '%q' "${PROJECT_DIR}/logs/bot.log") 2>&1"
COMMAND="${COMMAND//%/\\%}" # cron은 %를 줄바꿈으로 해석한다.
ENTRY="${SCHEDULE} ${COMMAND} ${MARKER}"

EXISTING="$(crontab_without_entry)"
if [[ -n "$EXISTING" ]]; then
  install_crontab "${EXISTING}"$'\n'"${ENTRY}"
else
  install_crontab "$ENTRY"
fi

if command -v systemctl >/dev/null 2>&1 &&
  ! systemctl is-active --quiet cron 2>/dev/null &&
  ! systemctl is-active --quiet crond 2>/dev/null; then
  warn "cron 서비스가 실행 중이 아닌 것 같습니다. (sudo systemctl enable --now cron 또는 crond)"
fi

cat <<EOF

crontab에 등록했습니다 ($(id -un)):
  ${ENTRY}

  로그 확인:   tail -f ${PROJECT_DIR}/logs/bot.log
  피드 추가:   pnpm feed add <url> [--name 이름]
  등록 해제:   ./linux-setup.sh --uninstall

node를 업그레이드하면 경로가 바뀔 수 있으니 이 스크립트를 다시 실행하세요.
EOF
