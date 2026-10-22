#!/usr/bin/env bash
# 逐页扫：横向溢出 / 幽灵滚动条 / 文本截断
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

ROUTES="/ /orders /orders/133 /quotations /samples /products /customers /reports /settings"

for route in $ROUTES; do
  taskkill //F //IM electron.exe //T >/dev/null 2>&1
  unset ELECTRON_RUN_AS_NODE
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  export IKAN_SHOT="$route" IKAN_SHOT_NAME=probe-sweep
  export IKAN_SHOT_JS="$(cat out/probe-sweep.js)"
  res=$(timeout 90 node_modules/.bin/electron . 2>&1 | grep -a -o 'ZZ{.*}ZZ' | head -1 | sed 's/^ZZ//; s/ZZ$//')
  taskkill //F //IM electron.exe //T >/dev/null 2>&1
  echo "=== $route"
  echo "$res" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(!s.trim()){console.log('  (no probe output)');return}const o=JSON.parse(s);console.log('  tables:',JSON.stringify(o.tables));console.log('  phantom:',o.phantom.length,'clipped:',JSON.stringify(o.clipped),'docOverflow:',o.docOverflow,'mainOverflow:',o.mainOverflow)})"
done
