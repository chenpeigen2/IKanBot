#!/usr/bin/env bash
# 逐页扫：横向溢出 / 幽灵滚动条 / 文本截断。
# 探针本体在 scripts/probe-sweep.js（已入 git，别再放回 out/——那是 gitignore 的产物目录，
# R50 就是这么把探针弄丢的：换台机器基线就没了）。
#
# 基线：docs/backend-plan.md 的 R59 记账段（macOS 重钉，替代旧 Windows 那套绝对值）。
# 九个路由的输出应与基线一致；版面真的改了（有意）就重跑一遍把基线数字换掉并写明原因，
# 不许静默漂移。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# /orders/<id> 取演示数据里的第一张单：npm run seed 后固定是 13（旧 Windows 库里是 133，已随基线作废）
ROUTES="/ /orders /orders/13 /quotations /samples /products /customers /reports /settings"

# 演示数据没建时扫出来全是空页，先把数据目录指到项目 data/（没有就先 npm run seed）
if [ -z "${IKAN_DATA_DIR:-}" ] && [ -f "$ROOT/data/ikanbot.db" ]; then
  export IKAN_DATA_DIR="$ROOT/data"
fi

for route in $ROUTES; do
  unset ELECTRON_RUN_AS_NODE
  export IKAN_SHOT="$route" IKAN_SHOT_NAME=probe-sweep
  export IKAN_SHOT_JS="$(cat "$ROOT/scripts/probe-sweep.js")"
  res=$(timeout 90 node_modules/.bin/electron . 2>&1 | grep -a -o 'ZZ{.*}ZZ' | head -1 | sed 's/^ZZ//; s/ZZ$//')
  echo "=== $route"
  echo "$res" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(!s.trim()){console.log('  (no probe output)');return}const o=JSON.parse(s);console.log('  tables:',JSON.stringify(o.tables));console.log('  phantom:',o.phantom.length,'clipped:',JSON.stringify(o.clipped),'docOverflow:',o.docOverflow,'mainOverflow:',o.mainOverflow)})"
done
