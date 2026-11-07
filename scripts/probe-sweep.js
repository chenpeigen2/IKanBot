(() => {
  // 版面探针：横向溢出 / 幽灵滚动 / 文本裁切。
  // （原 out/probe-sweep.js 是旧机器上的本地未入库文件，搬 macOS 时丢了；
  //   这份按 sweep.sh 消费的字段重建：tables / phantom / clipped / docOverflow / mainOverflow。）
  const round = (v) => Math.round(v * 1000) / 1000
  const out = { tables: {}, phantom: [], clipped: [], docOverflow: 0, mainOverflow: 0 }
  const label = (e) => {
    const cls = String(e.className ?? '').trim().split(/\s+/)[0]
    return cls || e.tagName.toLowerCase()
  }
  const de = document.documentElement
  out.docOverflow = round(Math.max(de.scrollWidth - de.clientWidth, 0))
  const main = document.querySelector('.main')
  if (main) out.mainOverflow = round(Math.max(main.scrollWidth - main.clientWidth, 0))
  document.querySelectorAll('table').forEach((t, i) => {
    const w = t.getBoundingClientRect().width
    const box = t.parentElement
    const boxW = box ? box.clientWidth : 0
    out.tables[`${label(t)}#${i}`] = { w: round(w), overflow: round(Math.max(w - boxW, 0)) }
  })
  // 幽灵滚动：overflow 可见的容器被内容撑出去（没有滚动条却溢出，才是毛病）
  document.querySelectorAll('div,section,main,td,th,span,p').forEach((e) => {
    const cs = getComputedStyle(e)
    if (cs.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 2) {
      out.phantom.push({ el: label(e), sw: e.scrollWidth, cw: e.clientWidth })
    }
  })
  // 文本被裁：overflow hidden / ellipsis 且内容超宽
  document.querySelectorAll('td,th,span,div,p').forEach((e) => {
    const cs = getComputedStyle(e)
    if ((cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 2) {
      out.clipped.push({ el: label(e), t: (e.textContent ?? '').trim().slice(0, 24) })
    }
  })
  console.log('ZZ' + JSON.stringify(out) + 'ZZ')
})()
