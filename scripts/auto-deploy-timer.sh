#!/usr/bin/env bash
# ============================================================
# 匹克球教学管理平台 · 服务器端定时自动部署（无需 GitHub 凭据的备选方案）
#
# 原理：systemd timer 每隔一段时间问 GitHub「main 分支最新 commit 是哪个」，
#       与本机记录的已部署 SHA 不同就下载源码包 → 跑门禁测试 → 部署 → 记录新 SHA。
#       仓库为 public，下载 tarball **不需要任何令牌**。
#
# 何时用这个而不是 GitHub Actions：
#   - 没有带 workflow scope 的 PAT，push 不上去 .github/workflows/*.yml
#   - 不想在公网暴露额外入口
#
# 差异：延迟 1 个轮询周期（默认 60 秒），而非 push 即触发。
#
# 环境变量：
#   REPO_OWNER / REPO_NAME / BRANCH   仓库坐标   默认 jervis829 / Pickleball / main
#   STATE_FILE                        已部署 SHA 记录 默认 /opt/pickleball-auto/state
#   WORK_DIR                          工作目录     默认 /opt/pickleball-auto/work
#   TARGET_DIR / SVC / APP_PORT ...   与 ci-deploy.sh 同义
# ============================================================
set -uo pipefail

REPO_OWNER="${REPO_OWNER:-jervis829}"
REPO_NAME="${REPO_NAME:-Pickleball}"
BRANCH="${BRANCH:-main}"
STATE_FILE="${STATE_FILE:-/opt/pickleball-auto/state}"
WORK_DIR="${WORK_DIR:-/opt/pickleball-auto/work}"
TARGET_DIR="${TARGET_DIR:-/opt/pickleball}"
SVC="${SVC:-pickleball}"
APP_PORT="${APP_PORT:-8787}"
APP_HOST="${APP_HOST:-127.0.0.1}"
NODE_BIN="${NODE_BIN:-/opt/node22/bin/node}"
DB_FILE="${DB_FILE:-data/pickleball.db}"
RUN_USER="${RUN_USER:-pkb}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/pickleball-backups}"
LOCK_FILE="${LOCK_FILE:-/opt/pickleball-auto/deploy.lock}"

log()  { printf '[auto-deploy] %s\n' "$*"; }

mkdir -p "$(dirname "$STATE_FILE")" "$WORK_DIR"

# ---------- [0] 防止并发重入 ----------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then log "已有部署在进行，跳过本次轮询"; exit 0; fi

# ---------- [1] 连通性 ----------
if ! curl -fsS -m 15 "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}" -o /dev/null; then
  log "无法访问 api.github.com，本次跳过（不影响线上服务）"
  exit 0
fi

# ---------- [2] 取 main 最新 SHA ----------
REMOTE_SHA="$(curl -fsS -m 20 "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}" \
  | "$NODE_BIN" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).sha||'')}catch(e){console.log('')}})")"
[ -n "$REMOTE_SHA" ] || { log "未能取得远端 SHA，跳过"; exit 0; }

LOCAL_SHA=""
[ -f "$STATE_FILE" ] && LOCAL_SHA="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then
  log "无新提交（${REMOTE_SHA:0:7}），跳过"
  exit 0
fi
log "检测到新提交：${LOCAL_SHA:0:7} → ${REMOTE_SHA:0:7}"

# ---------- [3] 下载源码包 ----------
TS="$(date +%Y%m%d_%H%M%S)"
PKG="${WORK_DIR}/src-${TS}.tar.gz"
UNPACK="${WORK_DIR}/src-${TS}"
URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}"
if ! curl -fL --retry 3 --max-time 180 -o "$PKG" "$URL"; then
  log "下载失败：$URL"
  exit 0
fi
mkdir -p "$UNPACK" && tar xzf "$PKG" -C "$UNPACK" --strip-components=1 || { log "解压失败"; exit 0; }
rm -f "$PKG"

# ---------- [4] 门禁测试（不过就不部署）----------
log "跑门禁测试…"
if ! ( cd "$UNPACK" && PATH="/opt/node22/bin:$PATH" \
        node --test backend/tests/*.test.js >/tmp/auto-deploy-test.log 2>&1 \
     && PATH="/opt/node22/bin:$PATH" npm run check:curriculum >>/tmp/auto-deploy-test.log 2>&1 \
     && PATH="/opt/node22/bin:$PATH" npm run check:frontend  >>/tmp/auto-deploy-test.log 2>&1 ); then
  log "门禁测试未通过，跳过部署（线上不受影响）。日志：/tmp/auto-deploy-test.log"
  exit 0
fi
log "门禁测试通过"

# ---------- [5] 部署（复用 ci-deploy.sh，自带回滚）----------
log "开始部署…"
if ( cd "$UNPACK" && TARGET_DIR="$TARGET_DIR" SVC="$SVC" APP_PORT="$APP_PORT" APP_HOST="$APP_HOST" \
        NODE_BIN="$NODE_BIN" DB_FILE="$DB_FILE" RUN_USER="$RUN_USER" BACKUP_ROOT="$BACKUP_ROOT" \
        bash scripts/ci-deploy.sh ); then
  printf '%s' "$REMOTE_SHA" > "$STATE_FILE"
  rm -rf "$UNPACK"
  log "部署成功，已记录 SHA ${REMOTE_SHA:0:7}"
else
  log "部署失败（ci-deploy.sh 已自动回滚），线上保持上一版本"
  rm -rf "$UNPACK"
  exit 1
fi
