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

# 窗口尺寸钉死：基线要换台电脑也能对，窗口落在哪块屏、系统缩放多少都会改表宽。
# 值与 main 进程里 IKAN_SHOT_SIZE 的解析对应；重钉基线时也是在这个尺寸下测的。
export IKAN_SHOT_SIZE=1600x1000

# 演示数据里的第一张单：seed 已重置自增计数器，重建后固定是 1。
# 这里仍从库里现查，免得哪天 seed 又动了 id，路由悄悄扫到一张空单上还报平安。
FIRST_ORDER=$(node -e "
const { Database } = require('$ROOT/node_modules/node-sqlite3-wasm');
const db = new Database('$ROOT/data/ikanbot.db');
const r = db.get('SELECT MIN(id) AS id FROM orders');
console.log(r && r.id ? Number(r.id) : 1);
db.close();
")

# /orders/<id> 取演示数据里的第一张单（seed 重置计数器后固定是 1）
ROUTES="/ /orders /orders/$FIRST_ORDER /quotations /samples /products /customers /reports /settings"

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
