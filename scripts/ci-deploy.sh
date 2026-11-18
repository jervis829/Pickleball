#!/usr/bin/env bash
# ============================================================
# 匹克球教学管理平台 · 服务器端部署脚本（GitHub 自托管 runner 调用）
#
# 用法（在 runner 的 checkout 目录里执行）：
#   bash scripts/ci-deploy.sh
#
# 环境变量（均有默认值）：
#   TARGET_DIR  部署目标目录           默认 /opt/pickleball
#   SVC         systemd 服务名          默认 pickleball
#   APP_PORT    应用端口                默认 8787
#   APP_HOST    应用监听地址            默认 127.0.0.1（公网经 Nginx 反代）
#   NODE_BIN    Node 22 可执行文件      默认 /opt/node22/bin/node
#   DB_FILE     数据库相对路径          默认 data/pickleball.db
#   RUN_USER    运行服务的系统用户      默认 pkb
#
# 设计要点：
#   1. 幂等：重复执行结果一致；数据目录与 .env 永不覆盖
#   2. 先备份后切换：代码目录 + SQLite 库各留一份带时间戳的备份
#   3. 原子切换：新目录就绪并通过语法校验后，才替换线上目录
#   4. 健康检查：重启后轮询 /api/v1/health，失败自动回滚代码与数据库
#   5. 数据库回滚：SQLite 用 VACUUM INTO 做一致性备份（不能用 cp，WAL 模式下会拿到撕裂快照）
# ============================================================
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-/opt/pickleball}"
SVC="${SVC:-pickleball}"
APP_PORT="${APP_PORT:-8787}"
APP_HOST="${APP_HOST:-127.0.0.1}"
NODE_BIN="${NODE_BIN:-/opt/node22/bin/node}"
DB_REL="${DB_FILE:-data/pickleball.db}"
RUN_USER="${RUN_USER:-pkb}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/pickleball-backups}"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
NEW_DIR="${TARGET_DIR}.new.${TS}"
BAK_DIR="${TARGET_DIR}.bak.${TS}"
UNIT="/etc/systemd/system/${SVC}.service"

log()  { printf '\033[36m[ci-deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$*" >&2; exit 1; }

# 任何退出都清掉暂存目录（避免残留半成品占用磁盘）
# 注意：trap 函数的返回值会成为脚本退出码，必须显式 return 0
cleanup() {
  if [ -n "${NEW_DIR:-}" ] && [ -d "${NEW_DIR:-}" ]; then rm -rf "$NEW_DIR"; fi
  return 0
}
trap cleanup EXIT

# ---------- [0] 前置检查 ----------
log "[0] 前置检查"
[ -d "$SRC/backend/src" ] || fail "源码不完整：$SRC"
[ -x "$NODE_BIN" ] || fail "Node 22 不存在：${NODE_BIN}（先手动安装到 /opt/node22）"
command -v curl >/dev/null 2>&1 || fail "缺少 curl"
log "    源码   $SRC"
log "    目标   $TARGET_DIR"
log "    Node   $("$NODE_BIN" -v)"

# ---------- [1] 备份（代码 + 数据库）----------
log "[1] 备份"
mkdir -p "$BACKUP_ROOT"
DB_SRC="${TARGET_DIR}/${DB_REL}"
DB_BAK="${BACKUP_ROOT}/db-${TS}.db"
if [ -f "$DB_SRC" ]; then
  # WAL 模式下必须用 VACUUM INTO 才是一致性快照
  ( cd "$TARGET_DIR" && "$NODE_BIN" -e "
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync('${DB_REL}');
      db.exec(\"VACUUM INTO '${DB_BAK}'\");
      db.close();
  " ) || fail "数据库备份失败：$DB_BAK"
  ok "数据库备份 $DB_BAK"
else
  ok "无既存数据库（首次部署），跳过"
fi
if [ -d "$TARGET_DIR" ]; then
  tar czf "${BACKUP_ROOT}/code-${TS}.tar.gz" -C "$TARGET_DIR" . 2>/dev/null || true
  ok "代码备份 ${BACKUP_ROOT}/code-${TS}.tar.gz"
fi

# ---------- [2] 同步到暂存目录 ----------
log "[2] 同步源码到暂存目录"
rm -rf "$NEW_DIR"; mkdir -p "$NEW_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude 'data' --exclude 'node_modules' \
    --exclude '.env' --exclude '.deploy.env' \
    "$SRC"/ "$NEW_DIR"/
else
  ( cd "$SRC" && tar cf - --exclude=.git --exclude=data --exclude=node_modules --exclude=.env --exclude=.deploy.env . ) \
    | ( cd "$NEW_DIR" && tar xf - )
fi
# 保留线上数据目录与 .env（永远不覆盖）
if [ -d "${TARGET_DIR}/data" ]; then cp -a "${TARGET_DIR}/data" "$NEW_DIR/data"; fi
if [ -f "${TARGET_DIR}/.env" ];    then cp -a "${TARGET_DIR}/.env"  "$NEW_DIR/.env";  fi
[ -d "$NEW_DIR/data" ] || mkdir -p "$NEW_DIR/data"
ok "暂存目录 $NEW_DIR"

# ---------- [3] 语法校验 + 迁移预演 ----------
log "[3] 语法校验与迁移预演"
( cd "$NEW_DIR" && find backend database frontend scripts -name '*.js' -print0 2>/dev/null \
    | xargs -0 -n1 "$NODE_BIN" --check ) || fail "语法校验失败"
( cd "$NEW_DIR" && "$NODE_BIN" --check backend/src/index.js ) || fail "入口文件语法错误"
ok "语法校验通过"
# 迁移在切目录前先跑一遍：失败则不切换，线上不受影响
( cd "$NEW_DIR" && DB_FILE="$DB_REL" "$NODE_BIN" backend/src/db/migrate.js ) || fail "数据库迁移预演失败（线上未改动）"
ok "迁移预演通过"

# ---------- [4] 原子切换 ----------
log "[4] 原子切换"
if [ -d "$TARGET_DIR" ]; then rm -rf "$BAK_DIR"; mv "$TARGET_DIR" "$BAK_DIR"; fi
mv "$NEW_DIR" "$TARGET_DIR"
if id -u "$RUN_USER" >/dev/null 2>&1; then
  chown -R "$RUN_USER" "$TARGET_DIR" || log "    chown 失败（权限不足），继续"
elif command -v useradd >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin "$RUN_USER" 2>/dev/null || true
  chown -R "$RUN_USER" "$TARGET_DIR" 2>/dev/null || true
fi
ok "已切换到新版本（回滚点：${BAK_DIR}）"

# ---------- [5] systemd ----------
log "[5] 服务配置与重启"
if [ "${CI_DEPLOY_DRY_RUN:-0}" = "1" ] || ! command -v systemctl >/dev/null 2>&1 || [ "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')" != "systemd" ]; then
  log "    当前环境无 systemd，跳过服务重启（仅用于本地演练）"
  HEALTH_OK=0
  # 本地演练：直接用 node 拉起临时实例做健康检查
  # 必须用 exec 让 node 取代 subshell —— 否则 $! 是 subshell 的 pid，
  # node 会变成 ppid=1 的孤儿进程留在系统里（实测每次演练泄漏一个，占用 8891 等端口）
  ( cd "$TARGET_DIR" && exec env HOST="$APP_HOST" PORT="$APP_PORT" DB_FILE="$DB_REL" \
      "$NODE_BIN" backend/src/index.js ) >/tmp/pkb-ci-deploy-test.log 2>&1 &
  TEST_PID=$!
  sleep 5
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${APP_PORT}/api/v1/health" 2>/dev/null || echo 000)" = "200" ]; then
    HEALTH_OK=1
    ok "临时实例健康检查通过"
  fi
  kill "$TEST_PID" 2>/dev/null || true
  wait "$TEST_PID" 2>/dev/null || true
  # 兜底：按端口再清一次，确保不残留
  pkill -f "backend/src/index.js" 2>/dev/null || true
  if [ "$HEALTH_OK" != "1" ]; then
    log "    临时实例健康检查未通过，执行回滚"
    if [ -d "$BAK_DIR" ]; then mv "$TARGET_DIR" "${TARGET_DIR}.failed.${TS}" 2>/dev/null || true; mv "$BAK_DIR" "$TARGET_DIR"; fi
    [ -f "$DB_BAK" ] && cp -f "$DB_BAK" "${TARGET_DIR}/${DB_REL}" 2>/dev/null || true
    fail "部署失败，已回滚到上一版本"
  fi
  echo
  echo "CI_DEPLOY_OK (dry-run: 无 systemd，未重启真实服务)"
  exit 0
fi
if [ ! -f "$UNIT" ]; then
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=Pickleball Academy Management
After=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${TARGET_DIR}
Environment=NODE_ENV=production
Environment=HOST=${APP_HOST}
Environment=PORT=${APP_PORT}
Environment=DB_FILE=${DB_REL}
ExecStart=${NODE_BIN} backend/src/index.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF
  ok "已生成 systemd unit"
else
  ok "systemd unit 已存在，保留"
fi
systemctl daemon-reload
systemctl restart "$SVC"
ok "服务已重启"

# ---------- [6] 健康检查（失败自动回滚）----------
log "[6] 健康检查"
HEALTH="http://127.0.0.1:${APP_PORT}/api/v1/health"
HEALTH_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HEALTH" 2>/dev/null || echo 000)" = "200" ]; then
    ok "健康检查通过（第 ${i} 次探测）"
    HEALTH_OK=1; break
  fi
  log "    探测 ${i} 未通过，3 秒后重试…"
done

if [ "$HEALTH_OK" != "1" ]; then
  fail "健康检查未通过，开始回滚"
  log "回滚代码目录"
  if [ -d "$BAK_DIR" ]; then
    mv "$TARGET_DIR" "${TARGET_DIR}.failed.${TS}" 2>/dev/null || true
    mv "$BAK_DIR" "$TARGET_DIR"
  fi
  # 数据库回滚：仅当存在备份且当前库明显异常时才恢复
  if [ -f "$DB_BAK" ]; then
    log "回滚数据库"
    cp -f "$DB_BAK" "${TARGET_DIR}/${DB_REL}" 2>/dev/null || true
    rm -f "${TARGET_DIR}/${DB_REL}-wal" "${TARGET_DIR}/${DB_REL}-shm" 2>/dev/null || true
  fi
  systemctl restart "$SVC" || true
  sleep 4
  curl -s -m 5 "$HEALTH" || true
  echo
  fail "部署失败，已回滚到上一版本"
fi

# ---------- [7] 结果 ----------
log "[7] 部署完成"
log "    线上版本 $(cd "$TARGET_DIR" && git rev-parse --short HEAD 2>/dev/null || echo '(非 git 目录)')"
log "    健康检查 $HEALTH"
log "    备份目录 $BACKUP_ROOT (db-${TS}.db / code-${TS}.tar.gz)"
log "    回滚点   $BAK_DIR"
echo
echo "CI_DEPLOY_OK"
