import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getDb, imagesDir, transact } from '../db'
import { mapProduct, mapProductImage } from '../db/mappers'
import { likeAny } from './search'
import type { Product, ProductImage } from '../../src/shared/types'

export interface ProductInput {
  id?: number
  styleNo: string
  name: string
  composition: string
  category?: string
  brand?: string
  season?: string
  /** 成本价（工厂价，按基准币记） */
  costPrice?: number | null
  sizes: string[]
  colors: string[]
  unitNetWeight?: number | null
  boxPieces?: number | null
  boxLength?: number | null
  boxWidth?: number | null
  boxHeight?: number | null
  factory?: string
  factoryNo?: string
  note?: string
  active?: number
}

function now(): string {
  return new Date().toISOString()
}

/** 款号归一：去掉首尾空格，A001 和 a001 是同一个款（重印找图就靠它） */
export function normalizeStyleNo(v: unknown): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ')
}

const nonNegative = (label: string, v: number | null | undefined): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${label}填的不是数字：${v}`)
  if (n < 0) throw new Error(`${label}不能是负数（现在填了 ${n}）。成本、重量、箱规填负数会把毛利算成假的。`)
  return n
}

function assertProductInput(input: ProductInput): void {
  const styleNo = normalizeStyleNo(input.styleNo)
  if (!styleNo) throw new Error('款号不能为空——单据和装箱单都靠款号认货，没号的商品不能存。')
  if (styleNo.length > 60) throw new Error(`款号太长了（${styleNo.length} 个字符），最多 60 个字符。`)
  const cost = Number(input.costPrice ?? 0)
  if (input.costPrice != null && !Number.isFinite(cost)) throw new Error(`成本价填的不是数字：${input.costPrice}`)
  nonNegative('成本价', input.costPrice)
  nonNegative('单件净重', input.unitNetWeight)
  nonNegative('每箱件数', input.boxPieces)
  nonNegative('箱长', input.boxLength)
  nonNegative('箱宽', input.boxWidth)
  nonNegative('箱高', input.boxHeight)
}

/** 款号查重：忽略大小写和空格，撞号时用中文说清楚，别把 SQLite 报错甩给老板 */
function assertStyleNoFree(styleNo: string, selfId?: number): void {
  const key = styleNo.toLowerCase()
  const rows = getDb().all('SELECT id, style_no FROM products') as { id?: number; style_no?: string }[]
  const hit = rows.find((r) => Number(r.id) !== selfId && normalizeStyleNo(r.style_no).toLowerCase() === key)
  if (hit) {
    throw new Error(
      `款号「${styleNo}」已经存在（${hit.style_no}，编号 ${hit.id}）。` +
        `同一个款号存两条，重印单据时不知道取哪一条的图和成本。` +
        `要做改款请用「复制」按钮起个新号；确实要改已有那款，直接在列表里点开那一条编辑。`
    )
  }
}

export function listProducts(keyword = '', includeInactive = false): Product[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number | null)[] = []
  if (!includeInactive) where.push('active = 1')
  if (keyword.trim()) {
    // 颜色/尺码/季节这些存在 JSON 列里，子串命中一样能搜到（跟单员就是按「海军蓝 M」找款的）
    const hit = likeAny(
      ['style_no', 'name', 'composition', 'note', 'factory', 'factory_no', 'colors', 'sizes', 'category', 'brand', 'season'],
      keyword.trim()
    )
    where.push(`(${hit.sql})`)
    params.push(...hit.params)
  }
  const sql = `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY style_no`
  return (db.all(sql, params) as Record<string, unknown>[]).map(mapProduct)
}

export function getProduct(id: number): Product | null {
  const row = getDb().get('SELECT * FROM products WHERE id = ?', [id]) as Record<string, unknown> | null
  return row ? mapProduct(row) : null
}

export function findProductByStyleNo(styleNo: string): Product | null {
  const key = normalizeStyleNo(styleNo).toLowerCase()
  if (!key) return null
  const rows = getDb().all('SELECT * FROM products') as Record<string, unknown>[]
  const hit = rows.map(mapProduct).find((p) => p.styleNo.toLowerCase() === key)
  return hit ?? null
}

export function saveProduct(input: ProductInput): Product {
  const db = getDb()
  assertProductInput(input)
  const styleNo = normalizeStyleNo(input.styleNo)
  assertStyleNoFree(styleNo, input.id)
  const ts = now()
  const sizes = JSON.stringify(
    (input.sizes ?? []).map((x) => String(x).trim()).filter((x, i, arr) => x && arr.indexOf(x) === i)
  )
  const colors = JSON.stringify(
    (input.colors ?? []).map((x) => String(x).trim()).filter((x, i, arr) => x && arr.indexOf(x) === i)
  )
  const cost = input.costPrice === null || input.costPrice === undefined ? null : Number(input.costPrice)
  const unitNetWeight =
    input.unitNetWeight === null || input.unitNetWeight === undefined ? null : Number(input.unitNetWeight)
  const boxPieces = input.boxPieces === null || input.boxPieces === undefined ? null : Number(input.boxPieces)
  const boxLength = input.boxLength === null || input.boxLength === undefined ? null : Number(input.boxLength)
  const boxWidth = input.boxWidth === null || input.boxWidth === undefined ? null : Number(input.boxWidth)
  const boxHeight = input.boxHeight === null || input.boxHeight === undefined ? null : Number(input.boxHeight)

  if (input.id) {
    // active 不传就保留原值：不能因为编辑一下就把「停用」的款重新启用
    const cur = db.get('SELECT active FROM products WHERE id = ?', [input.id]) as { active?: number } | null
    if (!cur) throw new Error('商品不存在，改不了')
    db.run(
      `UPDATE products SET style_no=?, name=?, composition=?, category=?, brand=?, season=?,
       cost_price=?, sizes=?, colors=?, unit_net_weight=?, box_pieces=?, box_length=?, box_width=?, box_height=?,
       factory=?, factory_no=?, note=?, active=?, updated_at=? WHERE id=?`,
      [
        styleNo,
        input.name ?? '',
        input.composition ?? '',
        input.category ?? '',
        input.brand ?? '',
        input.season ?? '',
        cost,
        sizes,
        colors,
        unitNetWeight,
        boxPieces,
        boxLength,
        boxWidth,
        boxHeight,
        (input.factory ?? '').trim(),
        (input.factoryNo ?? '').trim(),
        input.note ?? '',
        input.active ?? Number(cur.active ?? 1),
        ts,
        input.id
      ]
    )
    return getProduct(input.id)!
  }

  const res = db.run(
    `INSERT INTO products(style_no, name, composition, category, brand, season, cost_price, sizes, colors,
      unit_net_weight, box_pieces, box_length, box_width, box_height, factory, factory_no, note, active, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      styleNo,
      input.name ?? '',
      input.composition ?? '',
      input.category ?? '',
      input.brand ?? '',
      input.season ?? '',
      cost,
      sizes,
      colors,
      unitNetWeight,
      boxPieces,
      boxLength,
      boxWidth,
      boxHeight,
      (input.factory ?? '').trim(),
      (input.factoryNo ?? '').trim(),
      input.note ?? '',
      input.active ?? 1,
      ts,
      ts
    ]
  )
  return getProduct(Number(res.lastInsertRowid))!
}

export function setProductActive(id: number, active: 0 | 1): Product {
  const p = getProduct(id)
  if (!p) throw new Error('商品不存在')
  getDb().run('UPDATE products SET active = ?, updated_at = ? WHERE id = ?', [active ? 1 : 0, now(), id])
  return getProduct(id)!
}

/** 款号被哪些单据引用了（删之前先问清楚，别把历史单据变成没图没成本的空行） */
export function productReferenceCount(id: number): { orders: number; quotations: number; samples: number } {
  const db = getDb()
  const one = (sql: string): number => Number((db.get(sql, [id]) as { c?: number } | null)?.c ?? 0)
  return {
    orders: one('SELECT COUNT(*) c FROM order_items WHERE product_id = ?'),
    quotations: one('SELECT COUNT(*) c FROM quotation_items WHERE product_id = ?'),
    samples: one('SELECT COUNT(*) c FROM sample_order_items WHERE product_id = ?')
  }
}

export interface DeleteProductResult {
  /** true = 有历史引用，只做了停用；false = 真的删掉了 */
  deactivated: boolean
  message: string
}

/**
 * 删除商品。
 * 被历史单据引用过的款不能真删：单据重印要按款号找回主图和成本，
 * 删了以后重印的 PI 就少一张图，跟当初发出去的存档 PDF 对不上。
 */
export function deleteProduct(id: number): DeleteProductResult {
  const db = getDb()
  const p = getProduct(id)
  if (!p) return { deactivated: false, message: '' }
  const ref = productReferenceCount(id)
  const used = ref.orders + ref.quotations + ref.samples
  if (used > 0) {
    setProductActive(id, 0)
    const parts: string[] = []
    if (ref.orders) parts.push(`${ref.orders} 个订单行`)
    if (ref.quotations) parts.push(`${ref.quotations} 个报价行`)
    if (ref.samples) parts.push(`${ref.samples} 个打样行`)
    return {
      deactivated: true,
      message:
        `${p.styleNo} 还挂在${parts.join('、')}上，只做了「停用」没有真删——` +
        `真删了历史单据重印就找不到主图和成本，跟已经发出去的存档对不上。` +
        `停用后建单时不会再带出来，历史单据照常能重印。`
    }
  }
  // 没引用 = 真的录错了，连图片文件一起清掉，别让备份越滚越大
  const images = listProductImages(id)
  transact(() => {
    for (const im of images) db.run('DELETE FROM product_images WHERE id = ?', [im.id])
    db.run('DELETE FROM products WHERE id = ?', [id])
  })
  for (const im of images) {
    // 文件名是上传时唯一命名的，只有这一款在用；删不掉就当没看见，不挡主流程
    try {
      const p = join(imagesDir(), im.fileName)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* 文件已被手工移走：数据库记录已清，不留悬空引用就行 */
    }
  }
  return { deactivated: false, message: `${p.styleNo} 没有历史引用，已连同图片一并删除。` }
}

/** 复制款号建新款 */
export function copyProduct(id: number, newStyleNo: string): Product {
  const src = getProduct(id)
  if (!src) throw new Error('商品不存在')
  return saveProduct({
    styleNo: newStyleNo,
    name: src.name,
    composition: src.composition,
    category: src.category,
    brand: src.brand,
    season: src.season,
    costPrice: src.costPrice,
    sizes: [...src.sizes],
    colors: [...src.colors],
    unitNetWeight: src.unitNetWeight,
    boxPieces: src.boxPieces,
    boxLength: src.boxLength,
    boxWidth: src.boxWidth,
    boxHeight: src.boxHeight,
    factory: src.factory,
    factoryNo: src.factoryNo,
    note: src.note
  })
}

/* ---------------- CSV 导入 ---------------- */

/** 表头别名：Excel 里中文列名、英文列名都认 */
const CSV_ALIASES: Record<string, string> = {
  款号: 'styleNo',
  styleno: 'styleNo',
  style_no: 'styleNo',
  品名: 'name',
  name: 'name',
  成分: 'composition',
  composition: 'composition',
  面料: 'composition',
  尺码: 'sizes',
  sizes: 'sizes',
  size: 'sizes',
  颜色: 'colors',
  colors: 'colors',
  color: 'colors',
  成本: 'costPrice',
  成本价: 'costPrice',
  costprice: 'costPrice',
  cost: 'costPrice',
  工厂: 'factory',
  factory: 'factory',
  工厂货号: 'factoryNo',
  factoryno: 'factoryNo',
  工厂款号: 'factoryNo',
  每箱件数: 'boxPieces',
  boxpieces: 'boxPieces',
  箱规: 'box',
  box: 'box',
  单件净重: 'unitNetWeight',
  unitnetweight: 'unitNetWeight',
  类目: 'category',
  category: 'category',
  品牌: 'brand',
  brand: 'brand',
  季节: 'season',
  season: 'season',
  备注: 'note',
  note: 'note'
}

export const CSV_TEMPLATE_HEADER = '款号,品名,成分,尺码,颜色,成本价,工厂,工厂货号,每箱件数,箱规,单件净重,类目,品牌,季节,备注'

/** 一行 CSV：支持双引号包裹、引号内逗号和换行 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuote = false
      } else cur += ch
    } else if (ch === '"') inQuote = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

/** 整份 CSV → 行数组（引号里的换行也认） */
export function parseCsvRows(text: string): string[][] {
  const clean = text.replace(/^/, '').replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let cur = ''
  let inQuote = false
  const lines: string[] = []
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '"') {
      inQuote = !inQuote
      cur += ch
    } else if (ch === '\n' && !inQuote) {
      lines.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) lines.push(cur)
  for (const l of lines) {
    if (!l.trim()) continue
    rows.push(splitCsvLine(l))
  }
  return rows
}

/** S/M/L、"S M L"、"黑、白" 都能一次拆开 */
function splitTags(v: string): string[] {
  return v
    .split(/[,，、;；/|]+|\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i)
}

const numOr = (v: string): number | null => {
  const t = v.replace(/[¥$，,\s]/g, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  errors: string[]
}

/**
 * CSV 导入商品（Excel 另存为 CSV 即可）。
 * 已有款号默认跳过，mode=overwrite 才覆盖档案（历史单据引用的行不会被改号）。
 */
export function importProductsCsv(text: string, mode: 'skip' | 'overwrite' = 'skip'): ImportResult {
  const rows = parseCsvRows(text)
  const errors: string[] = []
  if (rows.length < 2) {
    throw new Error(
      `CSV 里除了表头没有内容（读到 ${rows.length} 行）。请用 Excel「另存为 CSV UTF-8」，第一行是表头，从第二行开始写款号。`
    )
  }
  const header = rows[0].map((h) => CSV_ALIASES[h.trim()] ?? CSV_ALIASES[h.trim().toLowerCase()] ?? h.trim())
  const col = (key: string): number => header.indexOf(key)
  const need = (r: string[], i: number): string => (i >= 0 ? String(r[i] ?? '').trim() : '')

  if (col('styleNo') < 0) {
    // 报出读到的表头，用户一眼能看出是编码问题还是真的少了列
    const seen = rows[0]
      .slice(0, 3)
      .map((h) => h.trim())
      .join(' | ')
    throw new Error(
      `CSV 第一行没找到「款号」这一列，读到的是「${seen || '(空)'}」。` +
        `要是这行看着像乱码，就是文件存成了别的编码：请用 Excel「另存为 → CSV UTF-8」再导一次。` +
        `表头请照这个写：${CSV_TEMPLATE_HEADER}`
    )
  }

  let created = 0
  let updated = 0
  let skipped = 0
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const lineNo = i + 1
    const styleNo = normalizeStyleNo(need(r, col('styleNo')))
    if (!styleNo) {
      skipped++
      errors.push(`第 ${lineNo} 行没有款号，跳过了`)
      continue
    }
    const boxRaw = need(r, col('box'))
    const box = boxRaw.split(/[×x*X*\s]+/).filter(Boolean).map((n) => Number(n))
    const boxOk = box.length === 3 && box.every((n) => Number.isFinite(n) && n > 0)
    const existing = findProductByStyleNo(styleNo)
    // 覆盖导入时：表头里没有这一列 = 这份 CSV 根本不打算管这个字段，保留库里原值。
    // 以前缺列一律按空串写回去——单证员只想拿 Excel 补一列成本价，整款的尺码、颜色、
    // 箱规、工厂就被顺手抹平了，装箱单的毛重估算和毛利跟着塌，界面还只报一句「更新 N 款」。
    // 表头里有这一列但格子是空的，仍按「明确要清空」处理（那是填表人的意思）。
    const overwriting = !!existing && mode === 'overwrite'
    const cur = existing
    const text = (key: string, keep: string | undefined): string =>
      col(key) >= 0 || !overwriting ? need(r, col(key)) : keep ?? ''
    const num = (key: string, keep: number | null | undefined): number | null =>
      col(key) >= 0 || !overwriting ? numOr(need(r, col(key))) : keep ?? null
    const tags = (key: string, keep: string[] | undefined): string[] =>
      col(key) >= 0 || !overwriting ? splitTags(need(r, col(key))) : keep ?? []
    const hasBoxCol = col('box') >= 0
    const boxSide = (i: number, keep: number | null | undefined): number | null =>
      hasBoxCol || !overwriting ? (boxOk ? box[i] : null) : keep ?? null
    const input: ProductInput = {
      id: existing?.id,
      styleNo,
      name: text('name', cur?.name),
      composition: text('composition', cur?.composition),
      category: text('category', cur?.category),
      brand: text('brand', cur?.brand),
      season: text('season', cur?.season),
      costPrice: num('costPrice', cur?.costPrice),
      sizes: tags('sizes', cur?.sizes),
      colors: tags('colors', cur?.colors),
      unitNetWeight: num('unitNetWeight', cur?.unitNetWeight),
      boxPieces: num('boxPieces', cur?.boxPieces),
      boxLength: boxSide(0, cur?.boxLength),
      boxWidth: boxSide(1, cur?.boxWidth),
      boxHeight: boxSide(2, cur?.boxHeight),
      factory: text('factory', cur?.factory),
      factoryNo: text('factoryNo', cur?.factoryNo),
      note: text('note', cur?.note)
    }
    try {
      if (existing) {
        if (mode !== 'overwrite') {
          skipped++
          continue
        }
        saveProduct(input)
        updated++
      } else {
        saveProduct(input)
        created++
      }
    } catch (e) {
      skipped++
      errors.push(`第 ${lineNo} 行 ${styleNo} 没导入：${(e as Error).message}`)
    }
  }
  return { created, updated, skipped, errors }
}

/* ---------------- 图片 ---------------- */

export function listProductImages(productId: number): ProductImage[] {
  const rows = getDb().all(
    'SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order, id',
    [productId]
  ) as Record<string, unknown>[]
  return rows.map(mapProductImage)
}

export function addProductImage(productId: number, fileName: string, isPrimary = false): ProductImage {
  const db = getDb()
  return transact(() => {
    // 有图就必须有一张主图：商品的第一张图无条件上位，不用界面传标志——
    // 界面那份「是不是第一张」在批量上传时人人都是 true，最后落哪张全看谁写得晚
    const hasAny = db.get('SELECT id FROM product_images WHERE product_id = ? LIMIT 1', [productId])
    const primary = isPrimary || !hasAny
    if (primary) db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ?', [productId])
    const max = db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_images WHERE product_id = ?', [
      productId
    ]) as { m: number }
    const res = db.run(
      'INSERT INTO product_images(product_id, file_name, is_primary, sort_order) VALUES(?,?,?,?)',
      [productId, fileName, primary ? 1 : 0, Number(max.m) + 1]
    )
    const row = db.get('SELECT * FROM product_images WHERE id = ?', [Number(res.lastInsertRowid)])
    if (!row) throw new Error('图片登记失败，请重试')
    return mapProductImage(row as Record<string, unknown>)
  })
}

export function deleteProductImage(id: number): void {
  const db = getDb()
  const row = db.get('SELECT product_id, file_name, is_primary FROM product_images WHERE id = ?', [id]) as
    | { product_id?: number; file_name?: string; is_primary?: number }
    | null
  if (!row) return
  transact(() => {
    db.run('DELETE FROM product_images WHERE id = ?', [id])
    if (Number(row.is_primary) === 1) {
      // 主图被删不能把商品留成「有图无主图」：按顺序顺延一张接班，
      // 否则商品卡一片空白，用户只能重新上传才能把主图找回来
      const next = db.get(
        'SELECT id FROM product_images WHERE product_id = ? ORDER BY sort_order, id LIMIT 1',
        [Number(row.product_id)]
      ) as { id?: number } | null
      if (next) db.run('UPDATE product_images SET is_primary = 1 WHERE id = ?', [Number(next.id)])
    }
  })
  if (row.file_name) {
    try {
      const p = join(imagesDir(), row.file_name)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* 文件已被手工移走：记录已清，不挡主流程 */
    }
  }
}

export function setPrimaryImage(productId: number, imageId: number): void {
  const db = getDb()
  transact(() => {
    // 先点中新的，再撤其余的：目标图不属于这个商品（列表没刷新、图已被删）时，
    // 旧写法会把原主图撤干净后设空——商品从此没有主图，而且一声不吭
    const res = db.run('UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ?', [
      imageId,
      productId
    ])
    if (Number(res.changes) !== 1)
      throw new Error('这张图已不在该商品下（可能刚被删掉），主图没有改动，请刷新图片列表后重试')
    db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ? AND id <> ?', [productId, imageId])
  })
}
