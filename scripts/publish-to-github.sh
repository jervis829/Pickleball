#!/usr/bin/env bash
# 把当前分支推送到 GitHub（jervis829/Pickleball）。
# PAT 只从 .env 的 GITHUB_PAT 读取，作为一次性 git 配置传入；
# 不写入 remote URL、不写入任何文件、不打印到控制台。
# 用法：在 .env 写一行 GITHUB_PAT=<token>（或 export GITHUB_PAT）后执行
#       bash scripts/publish-to-github.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 优先级：环境变量 > .env。两者都没有时给出明确指引。
PAT="${GITHUB_PAT:-}"
if [ -z "$PAT" ] && [ -f .env ]; then
  PAT=$(grep -E '^GITHUB_PAT=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')
fi
if [ -z "$PAT" ]; then
  cat >&2 <<'EOF'
缺少 GitHub 凭据。二选一：
  1) 本地写入（推荐）：printf 'GITHUB_PAT=你的token\n' > .env
  2) 临时环境变量：export GITHUB_PAT=你的token
然后重跑：bash scripts/publish-to-github.sh
PAT 生成：GitHub → Settings → Developer settings → Personal access tokens
  经典 PAT 勾选 repo；或细粒度 PAT 授予 Pickleball 仓库 Contents 读写。
EOF
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
AUTH=$(printf 'x-access-token:%s' "$PAT" | base64 | tr -d '\n')

# 部分网络环境对 GitHub 的 HTTP/2 支持不稳定（HTTP2 framing layer），强制 HTTP/1.1
if ! GIT_TERMINAL_PROMPT=0 \
  git -c "http.version=HTTP/1.1" \
      -c "http.extraheader=AUTHORIZATION: basic ${AUTH}" push -u origin "${BRANCH}" 2>&1; then
  echo "" >&2
  echo "推送失败。常见原因：PAT 无 repo/Contents 写权限、token 已过期、细粒度 PAT 未选中 Pickleball 仓库、或网络被拦截。" >&2
  exit 1
fi

echo "推送完成：$(git log --oneline -1)"
echo "仓库：$(git remote get-url origin)"
