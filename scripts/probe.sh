#!/usr/bin/env bash
# 带输出的探针截图：跑一段 JS，把结果从 renderer console 打进 stdout 的 ZZ...ZZ 标记里
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

ROUTE="${1:-/}"
NAME="${2:-probe}"
JS_FILE="${3:-out/probe-hbar.js}"

taskkill //F //IM electron.exe //T >/dev/null 2>&1
unset ELECTRON_RUN_AS_NODE
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export IKAN_SHOT="$ROUTE"
export IKAN_SHOT_NAME="$NAME"
export IKAN_SHOT_JS="$(cat "$JS_FILE")"

timeout 90 node_modules/.bin/electron . 2>&1 | grep -o 'ZZ{.*}ZZ' | head -1 | sed 's/^ZZ//; s/ZZ$//' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s.trim()),null,1))}catch(e){console.log(s)}})"
taskkill //F //IM electron.exe //T >/dev/null 2>&1
