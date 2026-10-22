#!/usr/bin/env bash
# 截图：启动应用、截指定页面、**保证退出**。
# 用法： scripts/shot.sh <路由> <文件名> [要执行的JS]
#   例： scripts/shot.sh /orders orders
#       scripts/shot.sh /orders/16 pi-preview '(()=>{...click()...})()'
#
# 关键：Electron 是 GUI 应用，任何异常都会让它挂住不放，
# 所以这里用 timeout 兜底，并在退出前强制杀掉残留的 electron 进程。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

ROUTE="${1:-/}"
NAME="${2:-shot}"
EXTRA_JS="${3:-}"

# 清理上一轮可能残留的进程
taskkill //F //IM electron.exe //T >/dev/null 2>&1

# 有些环境（CI / 沙箱）会把 ELECTRON_RUN_AS_NODE 设成 1，
# 那样 electron 会退化成普通 node 跑，`require('electron')` 拿到的是二进制路径字符串，
# 表现为 `electron.app` undefined、main 进程直接崩、一张图都拍不出来。
unset ELECTRON_RUN_AS_NODE

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export IKAN_SHOT="$ROUTE"
export IKAN_SHOT_NAME="$NAME"
[ -n "$EXTRA_JS" ] && export IKAN_SHOT_JS="$EXTRA_JS"

# 60 秒硬超时；应用正常会自己退出
timeout 60 node_modules/.bin/electron . >/dev/null 2>&1
RC=$?

# 无论成功失败，都不留下 electron 进程
taskkill //F //IM electron.exe //T >/dev/null 2>&1

if [ -f "out/shots/${NAME}.png" ]; then
  echo "saved out/shots/${NAME}.png"
  exit 0
fi
echo "截图失败（rc=$RC）：out/shots/${NAME}.png 未生成"
exit 1
