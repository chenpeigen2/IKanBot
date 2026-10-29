import { coreDb } from '../db'
import { customersCore, type CustomerInput } from '../../core/customers'
import type { CustomerOrderBrief, CustomerStats, StylePriceRow } from '../../src/shared/types'

export type { CustomerInput }

/**
 * 客户域全部在 core/customers.ts（本机与后端共用一份）。
 * 这里只是按桌面通道的旧名字转发，不再自己算数——客户页的三个数
 * 以前留在这里，后端要接就得抄第二份 SQL，成交额/坏账迟早各说各的。
 */
const core = customersCore(coreDb)

export const listCustomers = (keyword = '', includeInactive = false) =>
  core.list(keyword, includeInactive)

export const getCustomer = (id: number) => core.get(id)

export const saveCustomer = (input: CustomerInput) => core.save(input)

export const setCustomerActive = (id: number, active: 0 | 1) => core.setActive(id, active)

export const sameNameCustomers = (company: string, selfId?: number) => core.sameName(company, selfId)

export const deleteCustomer = (id: number) => core.remove(id)

export const stylePriceHistory = (filter: { customerId?: number; styleNo?: string } = {}): Promise<StylePriceRow[]> =>
  core.stylePriceHistory(filter)

export const customerStats = (id: number): Promise<CustomerStats> => core.stats(id)

export const customerOrderBriefs = (id: number): Promise<CustomerOrderBrief[]> => core.orderBriefs(id)
