#!/usr/bin/env bash
# ============================================================
# 匹克球教学管理平台 · SSH 连接辅助（解决「VPN 与 SSH 二选一」）
#
# 背景：七七 VPN 开启时把系统全局代理指向 127.0.0.1:9674 并改写路由，
#       导致到国内服务器（阿里云 47.93.190.91）的 22 端口流量被卷进隧道，
#       TCP 连得上但 sshd 的 banner 读不到（表现为 SSH 一直卡住）。
#       关闭 VPN 则 GitHub 不通、无法 push。
#
# 本脚本提供两个互相独立的通道：
#   A. ssh 直连通道：给服务器 IP 加一条 host 路由，强制走物理网卡，
#      不受 VPN 的路由改写影响 → VPN 开着也能 SSH。
#   B. git 推送通道：git 走 127.0.0.1:9674 的 HTTP 代理，
#      VPN 开着也能 push 到 GitHub。
#
# 用法：
#   bash scripts/ssh-vpn-helper.sh doctor     # 诊断当前状态（只读）
#   bash scripts/ssh-vpn-helper.sh route-on    # 开启服务器直连路由（需 sudo）
#   bash scripts/ssh-vpn-helper.sh route-off   # 关闭该路由
#   bash scripts/ssh-vpn-helper.sh git-on      # 让 git 走 VPN 代理
#   bash scripts/ssh-vpn-helper.sh git-off     # git 改回直连
#
# 幂等：重复执行同一命令不会报错；route-on 会把旧路由先删再加。
# ============================================================
set -uo pipefail

SERVER_IP="${SERVER_IP:-47.93.190.91}"
SERVER_PORT="${SERVER_PORT:-22}"
VPN_PROXY="${VPN_PROXY:-http://127.0.0.1:9674}"
GATEWAY="${GATEWAY:-192.168.0.1}"
IFACE="${IFACE:-en0}"
HOST_ROUTE="host ${SERVER_IP}"

log()  { printf '\033[36m[ssh-vpn]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m  !!\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  --\033[0m %s\n' "$*"; }

# ---------- 探测：SSH banner 是否可达 ----------
probe_ssh() {
  python3 - "$SERVER_IP" "$SERVER_PORT" <<'PY'
import socket, sys
ip, port = sys.argv[1], int(sys.argv[2])
try:
    s = socket.create_connection((ip, port), timeout=8); s.settimeout(8)
    d = s.recv(60); s.close()
    print('SSH_OK' if d.startswith(b'SSH-') else 'SSH_NO_BANNER')
except Exception as e:
    print('SSH_FAIL_' + type(e).__name__)
PY
}

probe_http() {
  code=$(curl -sS -o /dev/null -w '%{http_code}' -m 12 https://api.github.com 2>/dev/null || echo 000)
  echo "$code"
}

# ---------- doctor ----------
cmd_doctor() {
  log "服务器：${SERVER_IP}:${SERVER_PORT}"
  log "SSH banner 探测：$(probe_ssh)"
  log "GitHub api 探测（走当前系统代理）：$(probe_http)"

  echo
  log "路由现状："
  route -n get "$SERVER_IP" 2>/dev/null | grep -E "gateway|interface" | sed 's/^/    /' || warn "无路由条目"
  if netstat -rn 2>/dev/null | grep -q "${HOST_ROUTE}"; then
    ok "已存在 host 路由（${SERVER_IP} 走物理网卡）"
  else
    warn "未设置 host 路由 —— VPN 开启时 SSH 会被隧道吞掉"
  fi

  echo
  log "系统代理："
  scutil --proxy 2>/dev/null | grep -E "HTTPProxy|HTTPPort|HTTPSProxy|HTTPSPort" | sed 's/^/    /'

  echo
  log "git 代理配置："
  if git config --global --get http.proxy >/dev/null 2>&1; then
    ok "git 已配置代理：$(git config --global --get http.proxy)"
  else
    warn "git 未配置代理（默认直连；VPN 关闭时可用，VPN 开启时可能被隧道影响）"
  fi
  if [ -f "$HOME/.gitconfig" ] && grep -q "proxy" "$HOME/.gitconfig" 2>/dev/null; then
    echo "    .gitconfig 中所有 proxy 行："
    grep -n "proxy" "$HOME/.gitconfig" | sed 's/^/      /'
  fi

  echo
  log "建议："
  echo "    1) bash scripts/ssh-vpn-helper.sh route-on   # 让 SSH 始终能连（VPN 开着也有效）"
  echo "    2) bash scripts/ssh-vpn-helper.sh git-on    # 让 git push 始终能推（VPN 开着也有效）"
  echo "    3) 之后两条通道同时可用，不需要在 VPN 开关之间二选一"
}

# ---------- route-on / route-off ----------
cmd_route_on() {
  if ! netstat -rn 2>/dev/null | grep -q "${HOST_ROUTE}"; then
    log "添加 host 路由：${SERVER_IP} → ${GATEWAY} (${IFACE})"
    sudo route add -host "$SERVER_IP" "$GATEWAY" -if "$IFACE" 2>&1 | sed 's/^/    /' \
      || { bad "添加路由失败（需要 sudo 权限）"; return 1; }
  else
    log "host 路由已存在，先删除再重建以确保指向物理网卡"
    sudo route delete -host "$SERVER_IP" 2>&1 | sed 's/^/    /'
    sudo route add -host "$SERVER_IP" "$GATEWAY" -if "$IFACE" 2>&1 | sed 's/^/    /' \
      || { bad "添加路由失败"; return 1; }
  fi
  echo
  route -n get "$SERVER_IP" 2>/dev/null | grep -E "gateway|interface" | sed 's/^/    /'
  echo
  log "SSH banner 探测：$(probe_ssh)"
}

cmd_route_off() {
  log "删除 host 路由 ${SERVER_IP}"
  sudo route delete -host "$SERVER_IP" 2>&1 | sed 's/^/    /'
  echo
  log "当前路由："
  route -n get "$SERVER_IP" 2>/dev/null | grep -E "gateway|interface" | sed 's/^/    /' || warn "无条目"
}

# ---------- git-on / git-off ----------
cmd_git_on() {
  log "设置 git 全局代理：${VPN_PROXY}"
  git config --global http.proxy "$VPN_PROXY"
  git config --global https.proxy "$VPN_PROXY"
  ok "已设置。现在 git push 会走 VPN 代理"
  echo "    查看：git config --global --get http.proxy"
  echo "    撤销：bash scripts/ssh-vpn-helper.sh git-off"
}

cmd_git_off() {
  log "清除 git 全局代理"
  git config --global --unset http.proxy  2>/dev/null || true
  git config --global --unset https.proxy 2>/dev/null || true
  ok "已清除。现在 git 直连"
}

case "${1:-doctor}" in
  doctor)   cmd_doctor ;;
  route-on) cmd_route_on ;;
  route-off) cmd_route_off ;;
  git-on)   cmd_git_on ;;
  git-off)  cmd_git_off ;;
  *)
    echo "用法：bash scripts/ssh-vpn-helper.sh {doctor|route-on|route-off|git-on|git-off}" >&2
    exit 2
    ;;
esac
