/**
 * 客观数一遍四张单据的表头列数 vs 合计行占的列槽数。
 * 不看截图，只数 HTML 结构（colspan 求和）。
 * 用法：node scripts/count-doc-cols.cjs
 */
const path = require('path')
const fs = require('fs')

function rows(html) {
  // 抓 <table> ... </table> 里的 <tr>...</tr>
  const out = []
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let m
  while ((m = re.exec(html))) out.push(m[1])
  return out
}

function slotsOf(trHtml) {
  // 一个 tr 占的列槽数 = Σ(colspan)
  const re = /<t[hd][^>]*>/g
  let n = 0
  let mm
  while ((mm = re.exec(trHtml))) {
    const tag = mm[0]
    const cm = /colspan="(\d+)"/.exec(tag)
    n += cm ? Number(cm[1]) : 1
  }
  return n
}

function cellsOf(trHtml) {
  const re = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g
  const out = []
  let m
  while ((m = re.exec(trHtml))) {
    const tag = m[0]
    const cm = /colspan="(\d+)"/.exec(tag)
    out.push({ colspan: cm ? Number(cm[1]) : 1, text: m[1].replace(/<[^>]+>/g, '').trim() })
  }
  return out
}

function report(file, label) {
  const p = path.join(process.cwd(), 'out', 'shots', file)
  if (!fs.existsSync(p)) {
    console.log(`${label} (${file})：文件不存在，跳过`)
    return
  }
  const html = fs.readFileSync(p, 'utf8')
  const trs = rows(html)
  // 第一个 <table> 里的第一行是表头
  const headCells = cellsOf(trs[0])
  const headSlots = slotsOf(trs[0])
  // 找 TOTAL 合计行
  const totalIdx = trs.findIndex((t) => /TOTAL/.test(t))
  const totalCells = totalIdx >= 0 ? cellsOf(trs[totalIdx]) : []
  const totalSlots = totalIdx >= 0 ? slotsOf(trs[totalIdx]) : 0
  console.log('='.repeat(72))
  console.log(`${label}  (${file})`)
  console.log(`  表头：${headCells.length} 个 th，占 ${headSlots} 个列槽`)
  console.log(`    ${headCells.map((c, i) => `${i + 1}.${c.text.replace(/\s+/g, ' ')}`).join(' | ')}`)
  console.log(`  合计行（第 ${totalIdx + 1} 行）：${totalCells.length} 个 td，占 ${totalSlots} 个列槽`)
  totalCells.forEach((c, i) => {
    console.log(`    槽${i + 1}: colspan=${c.colspan}  内容="${c.text}"`)
  })
  const diff = totalSlots - headSlots
  console.log(`  结论：${diff === 0 ? '✅ 列数一致' : diff > 0 ? `❌ 多了 ${diff} 个列槽（幽灵列）` : `❌ 少了 ${-diff} 个列槽`}`)
}

console.log('当前 documents.ts 的 colspan 情况：')
const docs = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'documents.ts'), 'utf8')
const re = /<td colspan="(\d+)" class="center">TOTAL/g
let m
while ((m = re.exec(docs))) {
  const line = docs.slice(0, m.index).split('\n').length
  console.log(`  documents.ts:${line}  TOTAL 行 colspan="${m[1]}"`)
}

report('pi.html', 'PI 形式发票')
report('quotation.html', '报价单')
report('ci.html', 'CI 商业发票')
report('pl.html', 'PL 装箱单')
