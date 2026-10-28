import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { ImageStore } from '../files/image-store.service'
import {
  productsCore,
  type DeleteProductResult,
  type ImportResult,
  type ProductInput,
  type ProductsCore
} from '../../../core/products'
import type { Product, ProductImage } from '../../../src/shared/types'

/**
 * 商品域的后端正门：SQL 与守门全部来自 core/products.ts，
 * 这里只做两件事——把图片删除落到后端自己的目录，以及把「取不到」翻成 404。
 */
@Injectable()
export class ProductsService {
  private readonly core: ProductsCore

  constructor(@Inject(DB) db: Db, private readonly images: ImageStore) {
    this.core = productsCore(db)
  }

  list(keyword = '', includeInactive = false): Promise<Product[]> {
    return this.core.list(keyword, includeInactive)
  }

  get(id: number): Promise<Product> {
    return this.core.mustGet(id)
  }

  save(input: ProductInput | Record<string, unknown>): Promise<Product> {
    return this.core.save(input)
  }

  setActive(id: number, active: 0 | 1): Promise<Product> {
    return this.core.setActive(id, active)
  }

  referenceCount(id: number): Promise<{ orders: number; quotations: number; samples: number }> {
    return this.core.referenceCount(id)
  }

  copy(id: number, newStyleNo: string): Promise<Product> {
    return this.core.copy(id, newStyleNo)
  }

  importCsv(text: string, mode: 'skip' | 'overwrite'): Promise<ImportResult> {
    return this.core.importCsv(text, mode)
  }

  async remove(id: number): Promise<DeleteProductResult> {
    const r = await this.core.remove(id)
    for (const f of r.files) this.images.remove(f)
    return { deactivated: r.deactivated, message: r.message }
  }

  listImages(productId: number): Promise<ProductImage[]> {
    return this.core.listImages(productId)
  }

  addImage(productId: number, fileName: string, isPrimary = false): Promise<ProductImage> {
    return this.core.addImage(productId, fileName, isPrimary)
  }

  async removeImage(id: number): Promise<void> {
    const r = await this.core.removeImage(id)
    for (const f of r.files) this.images.remove(f)
  }

  setPrimary(productId: number, imageId: number): Promise<void> {
    return this.core.setPrimary(productId, imageId)
  }
}
