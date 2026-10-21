#!/usr/bin/env bash
# 截图 + 保留 stdout（用来看 renderer 里 console.log 的输出）
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
ROUTE="${1:-/}"
NAME="${2:-shot}"
EXTRA_JS="${3:-}"
taskkill //F //IM electron.exe //T >/dev/null 2>&1
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export IKAN_SHOT="$ROUTE"
export IKAN_SHOT_NAME="$NAME"
[ -n "$EXTRA_JS" ] && export IKAN_SHOT_JS="$EXTRA_JS"
timeout 90 node_modules/.bin/electron . 2>&1 | grep -v "^\[renderer:[0-9]\] $" | tail -200
taskkill //F //IM electron.exe //T >/dev/null 2>&1
if [ -f "out/shots/${NAME}.png" ]; then echo "saved out/shots/${NAME}.png"; else echo "SHOT FAILED"; fi
