#!/usr/bin/env bash
# ============================================================
# ci-deploy.sh 回归演练（可在任意机器跑，不碰线上）
#
# 覆盖 4 条路径：
#   ① 正向：已有旧版本 + 数据库 → 部署成功，数据与 .env 保留，旧代码被替换
#   ② 幂等：连续两次部署 → 第二次迁移无新增、结果一致
#   ③ 迁移预演失败 → 退出码非 0、线上目录不被改动
#   ④ 健康检查失败 → 自动回滚到上一版本、不误报成功
#
# 用法：bash scripts/test-ci-deploy.sh
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${REHEARSE_DIR:-/tmp/pkb-ci-rehearse}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
chk()  { if [ "$2" = "1" ]; then ok "$1"; else bad "$1"; fi; }

setup() {
  rm -rf "$ROOT"; mkdir -p "$ROOT"
  cp -a "$REPO_ROOT" "$ROOT/src"; rm -rf "$ROOT/src/.git"
  mkdir -p "$ROOT/target/data"
  printf 'ADMIN_PASSWORD=rehearse-secret\n' > "$ROOT/target/.env"
  printf 'GOOD-CODE\n' > "$ROOT/target/GOOD_MARKER.txt"
  ( cd "$ROOT/target" && "$NODE_BIN" -e "
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync('data/pickleball.db');
      db.exec('CREATE TABLE IF NOT EXISTS t(a TEXT)');
      db.exec(\"INSERT INTO t VALUES ('original-data')\");
      db.close();" 2>/dev/null )
}

run_deploy() { # $1=port
  TARGET_DIR="$ROOT/target" SVC=pkb-rehearse APP_PORT="$1" APP_HOST=127.0.0.1 \
    NODE_BIN="$NODE_BIN" DB_FILE=data/pickleball.db RUN_USER="$(whoami)" \
    BACKUP_ROOT="$ROOT/backups" CI_DEPLOY_DRY_RUN=1 bash "$ROOT/src/scripts/ci-deploy.sh"
}

echo "== ① 正向部署 =="
setup
run_deploy 8891 >"$ROOT/out1.log" 2>&1; RC=$?
if [ "$RC" != "0" ]; then echo "--- deploy log (scenario 1) ---"; cat "$ROOT/out1.log"; [ -f /tmp/pkb-ci-deploy-test.log ] && cat /tmp/pkb-ci-deploy-test.log; fi
chk "退出码为 0（实际 ${RC}）" "$([ "$RC" = "0" ] && echo 1 || echo 0)"
chk "数据库被保留" "$([ -f "$ROOT/target/data/pickleball.db" ] && echo 1 || echo 0)"
chk ".env 被保留" "$([ -f "$ROOT/target/.env" ] && echo 1 || echo 0)"
chk "旧代码被替换" "$([ ! -f "$ROOT/target/GOOD_MARKER.txt" ] && echo 1 || echo 0)"
chk "新代码已就位" "$([ -d "$ROOT/target/backend" ] && echo 1 || echo 0)"
chk "生成了数据库备份" "$(ls "$ROOT/backups"/db-*.db >/dev/null 2>&1 && echo 1 || echo 0)"
chk "备份内容完整" "$(grep -q 'original-data' "$ROOT/backups"/db-*.db 2>/dev/null && echo 1 || echo 0)"
chk "无残留暂存目录" "$(ls -d "$ROOT"/target.new.* >/dev/null 2>&1 && echo 0 || echo 1)"

echo "== ② 幂等（第二次部署）=="
run_deploy 8891 >"$ROOT/out2.log" 2>&1; RC=$?
if [ "$RC" != "0" ]; then echo "--- deploy log (scenario 2) ---"; cat "$ROOT/out2.log"; [ -f /tmp/pkb-ci-deploy-test.log ] && cat /tmp/pkb-ci-deploy-test.log; fi
chk "第二次退出码为 0（实际 ${RC}）" "$([ "$RC" = "0" ] && echo 1 || echo 0)"
chk "迁移无新增（幂等）" "$(grep -q '新增 0' "$ROOT/out2.log" && echo 1 || echo 0)"
chk "数据仍在" "$([ -f "$ROOT/target/data/pickleball.db" ] && echo 1 || echo 0)"

echo "== ③ 迁移预演失败 → 线上目录不动 =="
setup
printf 'THIS IS NOT VALID SQL;\n' > "$ROOT/src/database/migrations/999_broken.sql"
run_deploy 8892 >"$ROOT/out3.log" 2>&1; RC=$?
chk "退出码非 0（实际 ${RC}）" "$([ "$RC" != "0" ] && echo 1 || echo 0)"
chk "旧版本仍在原位" "$([ -f "$ROOT/target/GOOD_MARKER.txt" ] && echo 1 || echo 0)"
chk "未误报成功" "$(grep -q 'CI_DEPLOY_OK' "$ROOT/out3.log" && echo 0 || echo 1)"

echo "== ④ 健康检查失败 → 自动回滚 =="
setup
printf 'process.exit(1)\n' > "$ROOT/src/backend/src/index.js"
run_deploy 8893 >"$ROOT/out4.log" 2>&1; RC=$?
if [ "$RC" != "0" ]; then echo "--- deploy log (scenario 4) ---"; cat "$ROOT/out4.log"; [ -f /tmp/pkb-ci-deploy-test.log ] && cat /tmp/pkb-ci-deploy-test.log; fi
chk "退出码非 0（实际 ${RC}）" "$([ "$RC" != "0" ] && echo 1 || echo 0)"
chk "已回滚到上一版本" "$([ -f "$ROOT/target/GOOD_MARKER.txt" ] && echo 1 || echo 0)"
chk "未误报成功" "$(grep -q 'CI_DEPLOY_OK' "$ROOT/out4.log" && echo 0 || echo 1)"

echo
printf 'ci-deploy 回归：\033[32mpass=%d\033[0m fail=%d\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || exit 1
