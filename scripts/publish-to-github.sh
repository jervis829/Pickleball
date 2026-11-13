#!/usr/bin/env bash
# 把当前分支推送到 GitHub（jervis829/Pickleball）。
# PAT 只从 .env 的 GITHUB_PAT 读取，作为一次性 git 配置传入；
# 不写入 remote URL、不写入任何文件、不打印到控制台。
# 用法：在 .env 写一行 GITHUB_PAT=<token> 后执行 bash scripts/publish-to-github.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "缺少 .env，请先复制 .env.example 并写入 GITHUB_PAT" >&2
  exit 1
fi

PAT=$(grep -E '^GITHUB_PAT=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')
if [ -z "$PAT" ]; then
  echo ".env 中未找到 GITHUB_PAT" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
AUTH=$(printf 'x-access-token:%s' "$PAT" | base64 | tr -d '\n')

GIT_TERMINAL_PROMPT=0 \
  git -c "http.extraheader=AUTHORIZATION: basic ${AUTH}" push -u origin "${BRANCH}"

echo "推送完成：$(git log --oneline -1)"
echo "仓库：$(git remote get-url origin)"
