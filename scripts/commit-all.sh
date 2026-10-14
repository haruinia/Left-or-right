#!/bin/bash
# 一键提交当前所有改动（Gank 对齐：低调模式/会话记录/知识库/反馈/展示优化）
# 用法: bash scripts/commit-all.sh

set -euo pipefail
cd "$(dirname "$0")/.."

git add \
  desktop/main/config.js \
  desktop/main/index.js \
  desktop/assets/tray-stealth.png \
  desktop/assets/tray-stealth.svg \
  web/index.html \
  web/styles.css \
  web/modules/home.js \
  web/modules/feedback-store.js \
  web/modules/knowledge-base.js \
  web/modules/markdown.js \
  web/modules/session-store.js \
  docs/product-comparison-report.md \
  scripts/sync-web-to-app.sh \
  scripts/commit-all.sh

git commit -F /Users/why/.claude/jobs/cb7c2e5a/tmp/commit-msg.txt

echo ""
echo "已提交："
git log --oneline -1
echo ""
echo "如需推送到远端： git push"
