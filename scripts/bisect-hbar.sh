#!/usr/bin/env bash
# 每个候选单独起一次应用，互不污染
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

run() {
  local label="$1"
  local css="$2"
  printf 'window.__CSS__ = %s;\n' "$css" > out/probe-one.js
  cat out/probe-body.js >> out/probe-one.js
  taskkill //F //IM electron.exe //T >/dev/null 2>&1
  unset ELECTRON_RUN_AS_NODE
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  export IKAN_SHOT=/orders IKAN_SHOT_NAME=probe-one
  export IKAN_SHOT_JS="$(cat out/probe-one.js)"
  local res
  res=$(timeout 90 node_modules/.bin/electron . 2>&1 | grep -a -o 'ZZ{.*}ZZ' | head -1 | sed 's/^ZZ//; s/ZZ$//')
  taskkill //F //IM electron.exe //T >/dev/null 2>&1
  echo "$label => $res"
}

run "BASE           " "''"
run "noRowHeight    " "'table.data tbody tr { height: auto !important; }'"
run "noStickyTh     " "'table.data th { position: static !important; }'"
run "separateBorder " "'table.data { border-collapse: separate !important; border-spacing: 0 !important; }'"
run "noPageIn       " "'.main .content, .main .topbar { animation: none !important; }'"
