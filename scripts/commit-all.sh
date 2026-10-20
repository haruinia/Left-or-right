#!/bin/bash
# 一键提交当前所有改动
# 用法: bash scripts/commit-all.sh ["提交说明"]
# 不传说明时使用默认文案。

set -euo pipefail
cd "$(dirname "$0")/.."

MESSAGE="${1:-}"

git add -A

if [ -n "$(git diff --cached --name-only)" ]; then
  if [ -n "$MESSAGE" ]; then
    printf '%s\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' "$MESSAGE" > /tmp/liuwa-commit-msg.txt
    git commit -F /tmp/liuwa-commit-msg.txt
  else
    git commit -F - <<'MSG'
整理桌面端与 web 端交互

- 移除托盘与 Dock 驻留，改为纯全局快捷键驱动（对齐 Gank Interview）
- 主页极简化：只保留对话流、截图区与快捷键提示
- 设置中心迁移至 9958 静态服务，新增学习资产板块
- 新增离线 Markdown 渲染（含表格）与 web 预览调试页

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
  fi
  echo ""
  echo "已提交："
  git log --oneline -1
else
  echo "没有可提交的改动。"
fi

echo ""
echo "如需推送到远端： git push"
