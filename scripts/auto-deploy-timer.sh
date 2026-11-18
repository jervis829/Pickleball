#!/usr/bin/env bash
# ============================================================
# 匹克球教学管理平台 · 服务器端定时自动部署（无需 GitHub 凭据的备选方案）
#
# 原理：systemd timer 定期问 GitHub「main 的源码包变了没」，变了就下载 →
#       跑门禁测试 → 部署 → 记录新版本号。仓库为 public，全程不需要令牌。
#
# 变更检测用 codeload tarball 的 ETag 条件请求（If-None-Match）：
#   - 服务器在国内，github.com 页面端点(atom)与 git 协议端点(ls-remote)经常超时，
#     REST API 又有 60 次/小时匿名配额（60 秒轮询必然撞满 403）。
#   - codeload.github.com 实测稳定，且支持 ETag：
#       内容未变 → HTTP 304（近乎零流量、不消耗任何配额）
#       内容有变 → HTTP 200，响应体就是新 tarball（一次请求既检测又下载）
#   - state 文件保存上次成功部署的 ETag，作为「线上版本」的判据。
#
# 何时用这个而不是 GitHub Actions：
#   - 没有带 workflow scope 的 PAT，push 不上去 .github/workflows/*.yml
#   - 不想在公网暴露额外入口
#
# 差异：延迟 1 个轮询周期（默认 60 秒），而非 push 即触发。
#
# 环境变量：
#   REPO_OWNER / REPO_NAME / BRANCH   仓库坐标   默认 jervis829 / Pickleball / main
#   STATE_FILE                        已部署 ETag 记录 默认 /opt/pickleball-auto/state
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
# 用 PID 文件而不是 flock：
#   flock 的 fd 会被所有子进程继承，一旦某个子进程（如挂住的 git）不退出，
#   锁就永远不释放，后续每一轮轮询都会被"已有部署在进行"挡掉。
#   PID 文件则随进程退出自然失效，还能识别出"进程已死但锁文件还在"的僵尸状态。
if [ -f "$LOCK_FILE" ]; then
  OLD_PID="$(cat "$LOCK_FILE" 2>/dev/null || echo 0)"
  if [ "$OLD_PID" -gt 0 ] 2>/dev/null && kill -0 "$OLD_PID" 2>/dev/null; then
    log "已有部署在进行（pid ${OLD_PID}），跳过本次轮询"
    exit 0
  fi
  log "清理僵尸锁（pid ${OLD_PID} 已不存在）"
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
cleanup_lock() { rm -f "$LOCK_FILE"; }
trap cleanup_lock EXIT

# ---------- [1] 变更检测 + 下载（codeload ETag 条件请求）----------
TS="$(date +%Y%m%d_%H%M%S)"
PKG="${WORK_DIR}/src-${TS}.tar.gz"
UNPACK="${WORK_DIR}/src-${TS}"
HDR="${WORK_DIR}/hdr-${TS}"
URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${BRANCH}"

# 上次成功部署的 ETag；兼容旧格式：旧 state 存的是 40 位 SHA，不是 ETag，
# 形如 "xxx" 的才是 ETag。旧 SHA 一律当作无缓存 → 本轮全量拉取并迁移基线。
OLD_ETAG=""
if [ -f "$STATE_FILE" ]; then
  OLD_ETAG="$(tr -d '\r\n' < "$STATE_FILE" 2>/dev/null || true)"
fi
case "$OLD_ETAG" in
  \"*\") : ;;          # 合法 ETag（带引号），保留用于 If-None-Match
  *)     OLD_ETAG="" ;; # 旧 SHA / 空 / 其它，视为无 ETag
esac

# -f 会让 curl 在 4xx 时退出非 0；这里只用 %{http_code} 自己判断状态码，
# 故不加 -f，避免条件请求/异常状态被误判成网络错误。
CURL_ARGS=(-sSL --retry 3 --max-time 180 -D "$HDR" -o "$PKG" -w '%{http_code}')
if [ -n "$OLD_ETAG" ]; then
  CURL_ARGS+=(-H "If-None-Match: ${OLD_ETAG}")
fi
HTTP_CODE="$(curl "${CURL_ARGS[@]}" "$URL" 2>/dev/null || echo 000)"

case "$HTTP_CODE" in
  304)
    rm -f "$PKG" "$HDR"
    log "无新提交（ETag 未变 ${OLD_ETAG:1:10}…），跳过"
    exit 0
    ;;
  200)
    NEW_ETAG="$(grep -iE '^etag:' "$HDR" 2>/dev/null | tail -1 | sed 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r')"
    if [ -z "$NEW_ETAG" ]; then
      log "下载成功但响应无 ETag，无法记录基线，跳过（不影响线上）"
      rm -f "$PKG" "$HDR"
      exit 0
    fi
    # 极端情况：服务端忽略了 If-None-Match 仍回 200，但内容其实没变 → 不重复部署
    if [ "$NEW_ETAG" = "$OLD_ETAG" ]; then
      rm -f "$PKG" "$HDR"
      log "ETag 未变（${NEW_ETAG:1:10}…），跳过"
      exit 0
    fi
    log "检测到新版本：${OLD_ETAG:1:10} → ${NEW_ETAG:1:10}"
    ;;
  *)
    log "codeload 请求异常（HTTP $HTTP_CODE），本次跳过（不影响线上服务）"
    rm -f "$PKG" "$HDR"
    exit 0
    ;;
esac
rm -f "$HDR"

# ---------- [2] 解压 ----------
if ! mkdir -p "$UNPACK" || ! tar xzf "$PKG" -C "$UNPACK" --strip-components=1; then
  log "解压失败"; rm -f "$PKG"; exit 0
fi
rm -f "$PKG"

# ---------- [3] 门禁测试（不过就不部署）----------
log "跑门禁测试…"
if ! ( cd "$UNPACK" && PATH="/opt/node22/bin:$PATH" \
        node --test backend/tests/*.test.js >/tmp/auto-deploy-test.log 2>&1 \
     && PATH="/opt/node22/bin:$PATH" npm run check:curriculum >>/tmp/auto-deploy-test.log 2>&1 \
     && PATH="/opt/node22/bin:$PATH" npm run check:frontend  >>/tmp/auto-deploy-test.log 2>&1 ); then
  log "门禁测试未通过，跳过部署（线上不受影响）。日志：/tmp/auto-deploy-test.log"
  rm -rf "$UNPACK"
  exit 0
fi
log "门禁测试通过"

# ---------- [4] 部署（复用 ci-deploy.sh，自带回滚）----------
log "开始部署…"
if ( cd "$UNPACK" && TARGET_DIR="$TARGET_DIR" SVC="$SVC" APP_PORT="$APP_PORT" APP_HOST="$APP_HOST" \
        NODE_BIN="$NODE_BIN" DB_FILE="$DB_FILE" RUN_USER="$RUN_USER" BACKUP_ROOT="$BACKUP_ROOT" \
        bash scripts/ci-deploy.sh ); then
  printf '%s' "$NEW_ETAG" > "$STATE_FILE"
  rm -rf "$UNPACK"
  log "部署成功，已记录 ETag ${NEW_ETAG:1:10}"
else
  log "部署失败（ci-deploy.sh 已自动回滚），线上保持上一版本"
  rm -rf "$UNPACK"
  exit 1
fi
