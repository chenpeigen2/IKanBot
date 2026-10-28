/**
 * 桌面侧的商品服务：SQL 与守门全在 core/products.ts（后端跑同一份），
 * 这里只多一件 core 不该知道的事——本机图片目录里的文件要不要删。
 */
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { coreDb, imagesDir } from '../db'
import {
  CSV_TEMPLATE_HEADER,
  parseCsvRows,
  productsCore,
  type DeleteProductResult,
  type ImportResult,
  type ProductInput
} from '../../core/products'

export { CSV_TEMPLATE_HEADER, parseCsvRows }
export type { DeleteProductResult, ImportResult, ProductInput }

const core = productsCore(coreDb)

/** 图片文件名是上传时唯一命名的，只有这一款在用；删不掉就当没看见，不挡主流程 */
function dropLocalFiles(names: string[]): void {
  for (const name of names) {
    try {
      const p = join(imagesDir(), name)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* 文件已被手工移走：数据库记录已清，不留悬空引用就行 */
    }
  }
}

export const listProducts = (keyword = '', includeInactive = false) => core.list(keyword, includeInactive)
export const getProduct = (id: number) => core.get(id)
export const findProductByStyleNo = (styleNo: string) => core.findByStyleNo(styleNo)
export const saveProduct = (input: ProductInput) => core.save(input)
export const setProductActive = (id: number, active: 0 | 1) => core.setActive(id, active)
export const productReferenceCount = (id: number) => core.referenceCount(id)
export const copyProduct = (id: number, newStyleNo: string) => core.copy(id, newStyleNo)
export const importProductsCsv = (text: string, mode: 'skip' | 'overwrite' = 'skip') =>
  core.importCsv(text, mode)
export const listProductImages = (productId: number) => core.listImages(productId)
export const addProductImage = (productId: number, fileName: string, isPrimary = false) =>
  core.addImage(productId, fileName, isPrimary)
export const setPrimaryImage = (productId: number, imageId: number) => core.setPrimary(productId, imageId)

export async function deleteProduct(id: number): Promise<DeleteProductResult> {
  const r = await core.remove(id)
  dropLocalFiles(r.files)
  return { deactivated: r.deactivated, message: r.message }
}

export async function deleteProductImage(id: number): Promise<void> {
  const r = await core.removeImage(id)
  dropLocalFiles(r.files)
}
