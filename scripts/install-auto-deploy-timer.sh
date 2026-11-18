#!/usr/bin/env bash
# ============================================================
# 安装「服务器端定时自动部署」（systemd service + timer）
#
# 用法（在服务器上执行）：
#   bash scripts/install-auto-deploy-timer.sh
#
# 装完以后：
#   - 初次记录当前线上版本对应的 SHA（可传第一个参数，避免首次空转）
#   - 每 60 秒轮询一次 GitHub main 分支
#   - 有新提交 → 下载 → 门禁测试 → 部署 → 记录 SHA
#   - 门禁不过或部署失败 → 线上保持不变（ci-deploy.sh 内部还会再回滚一次）
#
# 查看状态： systemctl list-timers | grep pickleball
# 查看日志： journalctl -u pickleball-auto-deploy -n 50
# ============================================================
set -euo pipefail

SVC="pickleball-auto-deploy"
UNIT="/etc/systemd/system/${SVC}.service"
TIMER="/etc/systemd/system/${SVC}.timer"
INSTALL_DIR="/opt/pickleball-auto"
SCRIPT_SRC="${INSTALL_DIR}/auto-deploy-timer.sh"
CI_DEPLOY_SRC="${INSTALL_DIR}/ci-deploy.sh"

log()  { printf '\033[36m[install-timer]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() { printf '\033[31m!!!\033[0m %s\n' "$*" >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

log "[1] 检查运行环境"
[ -x /opt/node22/bin/node ] || fail "缺少 /opt/node22/bin/node"
timeout 25 git ls-remote https://github.com/jervis829/Pickleball.git refs/heads/main >/dev/null 2>&1 \
  || fail "服务器访问不到 github.com，定时轮询方案不可用"
ok "环境检查通过"

log "[2] 安装脚本到 ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
install -m 0755 "${SRC_DIR}/auto-deploy-timer.sh" "$SCRIPT_SRC"
install -m 0755 "${SRC_DIR}/ci-deploy.sh" "$CI_DEPLOY_SRC"
ok "已安装 auto-deploy-timer.sh 与 ci-deploy.sh"

log "[3] 生成 systemd service / timer"
cat > "$UNIT" <<EOF
[Unit]
Description=Pickleball auto deploy (poll GitHub)
After=network.target

[Service]
Type=oneshot
WorkingDirectory=${INSTALL_DIR}
# 显式给环境：systemd 默认不带 HOME，git 会因找不到凭据助手而挂起等输入
Environment=HOME=/root
Environment=PATH=/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=GIT_TERMINAL_PROMPT=0
Environment=GIT_ASKPASS=/bin/true
ExecStart=/bin/bash ${SCRIPT_SRC}
TimeoutStartSec=900
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Poll GitHub for Pickleball updates (every 60s)

[Timer]
OnBootSec=45s
OnUnitActiveSec=60s
AccuracySec=10s
Persistent=false

[Install]
WantedBy=timers.target
EOF
ok "已写入 $UNIT 与 $TIMER"

log "[4] 记录当前已部署版本（避免首次空转）"
STATE_FILE="${INSTALL_DIR}/state"
if [ ! -f "$STATE_FILE" ]; then
  SHA="$(timeout 25 git ls-remote https://github.com/jervis829/Pickleball.git refs/heads/main 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -n "$SHA" ]; then
    printf '%s' "$SHA" > "$STATE_FILE"
    ok "已记录基线 SHA ${SHA:0:7}（首次轮询不会重复部署）"
  else
    log "    未能取得基线 SHA，首次轮询会触发一次部署（属正常）"
  fi
fi

log "[5] 启用定时器"
systemctl daemon-reload
systemctl enable --now "${SVC}.timer"
sleep 2
systemctl list-timers --no-pager | grep -E "${SVC}|NEXT" | sed 's/^/    /' || true
ok "定时器已启用（每 60 秒轮询一次）"

cat <<'TIPS'

自检：
  systemctl list-timers | grep pickleball        # 看下次触发时间
  journalctl -u pickleball-auto-deploy -n 50     # 看最近日志
  cat /opt/pickleball-auto/state                 # 看当前已部署的 commit SHA

手动触发一次（不等轮询）：
  systemctl start pickleball-auto-deploy.service

关闭自动部署：
  systemctl disable --now pickleball-auto-deploy.timer
TIPS
