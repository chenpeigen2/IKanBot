import { getDb, dataDir, imagesDir } from '../db'
import type { AppSettings, BankAccount, Currency } from '../../src/shared/types'

const DEFAULTS: AppSettings = {
  company: {
    name: '',
    logoFile: '',
    address: '',
    phone: '',
    email: '',
    website: ''
  },
  banks: [],
  piValidDays: 15,
  defaultDepositRatio: 0.3,
  remindConfirmDays: 7,
  remindPaymentDays: 10,
  remindBalanceDays: 15,
  remindShipDays: 3,
  grossWeightFactor: 1.1,
  baseCurrency: 'CNY'
}

const KEY = 'app_settings'

export function getSettings(): AppSettings {
  const row = getDb().get('SELECT value FROM settings WHERE key = ?', [KEY]) as
    | { value: string }
    | null
  if (!row) return structuredClone(DEFAULTS)
  try {
    const parsed = JSON.parse(row.value) as Partial<AppSettings>
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      company: { ...DEFAULTS.company, ...(parsed.company ?? {}) },
      banks: parsed.banks ?? []
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

export function saveSettings(s: AppSettings): AppSettings {
  const merged: AppSettings = {
    ...s,
    company: { ...s.company },
    banks: s.banks ?? []
  }
  getDb().run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    KEY,
    JSON.stringify(merged)
  ])
  return merged
}

/** 构造默认银行账户列表（从币种集合生成空壳） */
export function defaultBanks(currencies: Currency[]): BankAccount[] {
  return currencies.map((currency) => ({
    currency,
    bankName: '',
    accountName: '',
    accountNo: '',
    swift: '',
    address: ''
  }))
}

export function companyLogoPath(): string {
  const s = getSettings()
  if (!s.company.logoFile) return ''
  return `${imagesDir()}/${s.company.logoFile}`
}

export function dataRoot(): string {
  return dataDir()
}
