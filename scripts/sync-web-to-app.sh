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
# 同步整个资源树，包括 selector 页面、公式字体、代码高亮及后续新增模块。
# 逐个枚举文件曾漏掉 vendor/ 和 select.html，造成源码可用、安装版缺资源。
rsync -a "$REPO_ROOT/web/" "$APP_WEB/"

echo "重启 左右.app…"
killall "左右" 2>/dev/null || true
sleep 1
open "/Applications/左右.app"

echo "完成。已同步并重启。"
