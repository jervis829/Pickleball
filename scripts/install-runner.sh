#!/usr/bin/env bash
# ============================================================
# 匹克球教学管理平台 · GitHub 自托管 runner 安装脚本（在服务器上执行）
#
# 用法：
#   bash scripts/install-runner.sh <仓库所有者> <仓库名> <注册令牌>
# 例：
#   bash scripts/install-runner.sh jervis829 Pickleball ghp_xxxxxxxxxxxx
#
# 注册令牌获取：GitHub → 仓库 → Settings → Actions → Runners → New self-hosted runner
#   → 复制页面给出的 registration token（形如 AXXXXXXXXXXXXXXXXXX）
#
# 说明：
#   - runner 以 root 运行最简单（需要写 /opt/pickleball 与 systemctl）
#   - 用 systemd 常驻，服务器重启后自动拉起
#   - 装完以后，push 到 main 就会自动触发 .github/workflows/deploy.yml
# ============================================================
set -euo pipefail

REPO_OWNER="${1:-jervis829}"
REPO_NAME="${2:-Pickleball}"
TOKEN="${3:-${RUNNER_TOKEN:-}}"
RUNNER_VERSION="${RUNNER_VERSION:-2.328.0}"
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"
RUNNER_LABELS="${RUNNER_LABELS:-pickleball,linux,x64}"

log()  { printf '\033[36m[install-runner]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$TOKEN" ] || fail "缺少注册令牌。用法：bash scripts/install-runner.sh <owner> <repo> <registration-token>"

# ---------- [1] 服务器必须能访问 GitHub ----------
log "[1] 检查服务器到 GitHub 的连通性"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.github.com 2>/dev/null || echo 000)"
if [ "$CODE" != "200" ]; then
  fail "服务器无法访问 api.github.com（HTTP ${CODE}）。自托管 runner 需要出网访问 GitHub；
若此路不通，请改用方案 B（GitHub 托管 runner 经 SSH 部署）。"
fi
ok "api.github.com 可达"

# ---------- [2] 下载并解压 runner ----------
log "[2] 下载 runner ${RUNNER_VERSION}"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"
if [ ! -x "./run.sh" ]; then
  URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  curl -fL --retry 3 --max-time 300 -o runner.tar.gz "$URL" || fail "下载失败：$URL"
  tar xzf runner.tar.gz && rm -f runner.tar.gz
fi
[ -x ./run.sh ] || fail "runner 解压后缺少 run.sh"
ok "runner 就位 $RUNNER_DIR"

# ---------- [3] 注册到仓库 ----------
log "[3] 注册到 ${REPO_OWNER}/${REPO_NAME}"
./config.sh \
  --url "https://github.com/${REPO_OWNER}/${REPO_NAME}" \
  --token "$TOKEN" \
  --labels "$RUNNER_LABELS" \
  --unattended \
  --replace
ok "注册完成（labels: ${RUNNER_LABELS}）"

# ---------- [4] systemd 常驻 ----------
log "[4] 安装 systemd 服务"
./svc.sh install runner
./svc.sh start runner
sleep 3
if ./svc.sh status >/dev/null 2>&1; then
  ok "runner 服务已启动（开机自启）"
else
  log "    服务状态异常，可执行 journalctl -u actions.runner.actions-runner.service -n 30 查看"
fi

cat <<'TIPS'

下一步：
  1. 回到 GitHub 仓库 → Settings → Actions → Runners，确认出现名为 xxx 的自托管 runner（在线）
  2. 本地执行：git push origin main
  3. 到仓库 Actions 标签页看流水线：门禁测试（21+57+55 项）→ 服务器部署 → 健康检查
  4. 若流水线失败，服务器会自动回滚到上一版本；日志里会打印回滚点路径

安全提示：注册令牌用过即失效，不要写进仓库；这里只在命令行传入，未落盘。
TIPS
