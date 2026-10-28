import { Inject, Injectable } from '@nestjs/common'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { customersCore, type CustomersCore } from '../../../core/customers'
import type { Customer } from '../../../src/shared/types'

/**
 * 客户域的 HTTP 门面：SQL 与守门全在 core/customers.ts，
 * 这里只负责把 Nest 的 Db 交给它——桌面端走同一个 core，只是 Db 换成本机适配器。
 */
@Injectable()
export class CustomersService {
  private readonly core: CustomersCore

  constructor(@Inject(DB) db: Db) {
    this.core = customersCore(db)
  }

  list(keyword = '', includeInactive = false): Promise<Customer[]> {
    return this.core.list(keyword, includeInactive)
  }

  get(id: number): Promise<Customer> {
    // core 抛 BizError(404)，全局过滤器翻成「客户不存在」的 404 中文错误体
    return this.core.mustGet(id)
  }

  sameName(company: string, selfId?: number): Promise<Customer[]> {
    return this.core.sameName(company, selfId)
  }

  save(raw: Record<string, unknown>): Promise<Customer> {
    return this.core.save(raw)
  }

  setActive(id: number, active: 0 | 1): Promise<Customer> {
    return this.core.setActive(id, active)
  }

  remove(id: number): Promise<void> {
    return this.core.remove(id)
  }
}
