#!/bin/bash
# 把仓库里的 web 前端文件同步到已安装的「左右.app」并重启应用。
# 适用于只改了 web/ 下的前端代码、不想重新打包 DMG 的场景。
# 用法: bash scripts/sync-web-to-app.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_WEB="/Applications/左右.app/Contents/Resources/web"

if [ ! -d "$APP_WEB" ]; then
  echo "未找到 $APP_WEB"
  echo "请先安装 左右.app 到 /Applications（或修改本脚本中的路径）。"
  exit 1
fi

echo "同步 web 文件到已安装应用…"
cp "$REPO_ROOT/web/index.html" "$APP_WEB/index.html"
cp "$REPO_ROOT/web/settings.html" "$APP_WEB/settings.html"
cp "$REPO_ROOT/web/cockpit.html" "$APP_WEB/cockpit.html" 2>/dev/null || true
cp "$REPO_ROOT/web/styles.css" "$APP_WEB/styles.css"
cp "$REPO_ROOT/web/modules/"*.js "$APP_WEB/modules/"
cp "$REPO_ROOT/web/modules/"*.svg "$APP_WEB/modules/" 2>/dev/null || true

echo "重启 左右.app…"
killall "左右" 2>/dev/null || true
sleep 1
open "/Applications/左右.app"

echo "完成。已同步并重启。"
