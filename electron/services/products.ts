import { getDb } from '../db'
import { mapProduct, mapProductImage } from '../db/mappers'
import type { Product, ProductImage } from '../../src/shared/types'

export interface ProductInput {
  id?: number
  styleNo: string
  name: string
  composition: string
  category?: string
  brand?: string
  season?: string
  costPrice?: number | null
  sizes: string[]
  colors: string[]
  unitNetWeight?: number | null
  boxPieces?: number | null
  boxLength?: number | null
  boxWidth?: number | null
  boxHeight?: number | null
  note?: string
  active?: number
}

function now(): string {
  return new Date().toISOString()
}

export function listProducts(keyword = '', includeInactive = false): Product[] {
  const db = getDb()
  const where: string[] = []
  const params: (string | number | null)[] = []
  if (!includeInactive) where.push('active = 1')
  if (keyword.trim()) {
    where.push('(style_no LIKE ? OR name LIKE ? OR composition LIKE ? OR note LIKE ?)')
    const k = `%${keyword.trim()}%`
    params.push(k, k, k, k)
  }
  const sql = `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY style_no`
  return (db.all(sql, params) as Record<string, unknown>[]).map(mapProduct)
}

export function getProduct(id: number): Product | null {
  const row = getDb().get('SELECT * FROM products WHERE id = ?', [id]) as Record<string, unknown> | null
  return row ? mapProduct(row) : null
}

export function saveProduct(input: ProductInput): Product {
  const db = getDb()
  const ts = now()
  const sizes = JSON.stringify(input.sizes ?? [])
  const colors = JSON.stringify(input.colors ?? [])
  const cost = input.costPrice === null || input.costPrice === undefined ? null : Number(input.costPrice)
  const unitNetWeight =
    input.unitNetWeight === null || input.unitNetWeight === undefined ? null : Number(input.unitNetWeight)
  const boxPieces = input.boxPieces === null || input.boxPieces === undefined ? null : Number(input.boxPieces)
  const boxLength = input.boxLength === null || input.boxLength === undefined ? null : Number(input.boxLength)
  const boxWidth = input.boxWidth === null || input.boxWidth === undefined ? null : Number(input.boxWidth)
  const boxHeight = input.boxHeight === null || input.boxHeight === undefined ? null : Number(input.boxHeight)

  if (input.id) {
    db.run(
      `UPDATE products SET style_no=?, name=?, composition=?, category=?, brand=?, season=?,
       cost_price=?, sizes=?, colors=?, unit_net_weight=?, box_pieces=?, box_length=?, box_width=?, box_height=?,
       note=?, active=?, updated_at=? WHERE id=?`,
      [
        input.styleNo.trim(),
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
        input.note ?? '',
        input.active ?? 1,
        ts,
        input.id
      ]
    )
    return getProduct(input.id)!
  }

  const res = db.run(
    `INSERT INTO products(style_no, name, composition, category, brand, season, cost_price, sizes, colors,
      unit_net_weight, box_pieces, box_length, box_width, box_height, note, active, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.styleNo.trim(),
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
      input.note ?? '',
      input.active ?? 1,
      ts,
      ts
    ]
  )
  return getProduct(Number(res.lastInsertRowid))!
}

export function deleteProduct(id: number): void {
  getDb().run('DELETE FROM products WHERE id = ?', [id])
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
    note: src.note
  })
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
  if (isPrimary) db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ?', [productId])
  const max = db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_images WHERE product_id = ?', [
    productId
  ]) as { m: number }
  const res = db.run(
    'INSERT INTO product_images(product_id, file_name, is_primary, sort_order) VALUES(?,?,?,?)',
    [productId, fileName, isPrimary ? 1 : 0, Number(max.m) + 1]
  )
  const row = db.get('SELECT * FROM product_images WHERE id = ?', [Number(res.lastInsertRowid)])
  return mapProductImage(row as Record<string, unknown>)
}

export function deleteProductImage(id: number): void {
  getDb().run('DELETE FROM product_images WHERE id = ?', [id])
}

export function setPrimaryImage(productId: number, imageId: number): void {
  const db = getDb()
  db.run('UPDATE product_images SET is_primary = 0 WHERE product_id = ?', [productId])
  db.run('UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ?', [imageId, productId])
}
