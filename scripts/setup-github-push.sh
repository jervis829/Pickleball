#!/usr/bin/env bash
# 交互式一键推送：粘贴 GitHub PAT -> 写入 .env（权限 600）-> 推送到 origin
# token 不回显、不打印、不进入任何命令参数或 git 配置、不入库。
# 用法：bash scripts/setup-github-push.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "如果还没有 token，先在浏览器打开：https://github.com/settings/tokens/new"
echo "  Note 填 pickleball-push；Expiration 选 7 days；勾选 repo；点 Generate token 后立刻复制。"
echo ""
read -rs -p "粘贴 PAT（输入不回显），回车确认: " RAW_PAT
echo ""
PAT=$(printf '%s' "$RAW_PAT" | tr -d ' \t\r\n')
unset RAW_PAT
if [ -z "$PAT" ]; then
  echo "未检测到 token，已取消（未写入任何文件）。" >&2
  exit 1
fi

umask 077
printf 'GITHUB_PAT=%s\n' "$PAT" > .env
chmod 600 .env
unset PAT
echo "已写入 .env（chmod 600，且已被 .gitignore 排除）"

bash scripts/publish-to-github.sh

echo ""
echo "推送完成，建议现在撤销该 token：https://github.com/settings/tokens"
