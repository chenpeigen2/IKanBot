#!/usr/bin/env bash
# 重拍全套 after 截图：a-<名字>.png
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

shoot() {
  local route="$1" name="$2" js="${3:-}"
  if [ -n "$js" ]; then
    bash scripts/shot.sh "$route" "$name" "$(cat "$js")"
  else
    bash scripts/shot.sh "$route" "$name"
  fi
}

shoot /            a-dash
shoot /orders      a-orders
shoot /orders/133  a-detail
shoot /quotations  a-quo
shoot /samples     a-samples
shoot /products    a-products
shoot /customers   a-cust
shoot /reports     a-reports
shoot /settings    a-settings
shoot /orders/133  a-doc-pi out/open-pi.js
