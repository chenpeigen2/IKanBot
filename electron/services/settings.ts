import { getDb, dataDir, imagesDir } from '../db'
import { CURRENCIES, type AppSettings, type BankAccount, type Currency } from '../../src/shared/types'

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
  baseCurrency: 'CNY',
  operator: '',
  lastBackupAt: null,
  lastBackupError: null
}

const KEY = 'app_settings'

/** 天数类设置：下限 / 上限（0 表示「当天就提醒」，是合法值） */
const DAY_FIELDS = [
  ['piValidDays', 'PI 有效期', 1, 365],
  ['remindConfirmDays', '催确认阈值', 0, 365],
  ['remindPaymentDays', '催款阈值', 0, 365],
  ['remindBalanceDays', '催尾款阈值', 0, 365],
  ['remindShipDays', '出货提醒提前', 0, 90]
] as const

const TEXT_LIMITS: Array<[keyof AppSettings['company'], string, number]> = [
  ['name', '公司名称', 200],
  ['address', '公司地址', 300],
  ['phone', '公司电话', 100],
  ['email', '公司邮箱', 100],
  ['website', '公司网站', 100]
]

const BANK_TEXT_LIMITS: Array<[keyof Omit<BankAccount, 'currency'>, string, number]> = [
  ['accountName', '账户名', 120],
  ['bankName', '银行名称', 120],
  ['accountNo', '账号', 64],
  ['swift', 'SWIFT 代码', 32],
  ['address', '银行地址', 300]
]

function isCurrency(v: unknown): v is Currency {
  return typeof v === 'string' && (CURRENCIES as string[]).includes(v)
}

function textOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function dayOf(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/**
 * 读库时的兜底：库里那份 JSON 可能是老版本写的、也可能被手工改坏。
 * 读的时候只能往默认值退，绝不能把默认值冲掉——
 * 之前 `...parsed` 一摊，存了个 null 进去就永久盖住默认值，设置页显示空白、
 * 报表按空值算，谁也看不出是数据坏了。
 */
function normalizeSettings(parsed: unknown): AppSettings {
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  const company = (p.company && typeof p.company === 'object' ? p.company : {}) as Record<string, unknown>
  const banks = Array.isArray(p.banks) ? p.banks : []
  const seen = new Set<Currency>()
  return {
    company: {
      name: textOf(company.name),
      logoFile: textOf(company.logoFile),
      address: textOf(company.address),
      phone: textOf(company.phone),
      email: textOf(company.email),
      website: textOf(company.website)
    },
    banks: banks
      .filter((b) => b && typeof b === 'object' && isCurrency((b as Record<string, unknown>).currency))
      .map((b) => b as Record<string, unknown>)
      .filter((b) => {
        const c = b.currency as Currency
        if (seen.has(c)) return false
        seen.add(c)
        return true
      })
      .map((b) => ({
        currency: b.currency as Currency,
        bankName: textOf(b.bankName),
        accountName: textOf(b.accountName),
        accountNo: textOf(b.accountNo),
        swift: textOf(b.swift),
        address: textOf(b.address)
      })),
    piValidDays: dayOf(p.piValidDays, DEFAULTS.piValidDays, 1, 365),
    defaultDepositRatio: ratioOf(p.defaultDepositRatio, DEFAULTS.defaultDepositRatio),
    remindConfirmDays: dayOf(p.remindConfirmDays, DEFAULTS.remindConfirmDays, 0, 365),
    remindPaymentDays: dayOf(p.remindPaymentDays, DEFAULTS.remindPaymentDays, 0, 365),
    remindBalanceDays: dayOf(p.remindBalanceDays, DEFAULTS.remindBalanceDays, 0, 365),
    remindShipDays: dayOf(p.remindShipDays, DEFAULTS.remindShipDays, 0, 90),
    grossWeightFactor: factorOf(p.grossWeightFactor, DEFAULTS.grossWeightFactor),
    baseCurrency: isCurrency(p.baseCurrency) ? p.baseCurrency : DEFAULTS.baseCurrency,
    operator: textOf(p.operator).trim().slice(0, 40),
    lastBackupAt: typeof p.lastBackupAt === 'string' ? p.lastBackupAt : null,
    lastBackupError: typeof p.lastBackupError === 'string' ? p.lastBackupError : null
  }
}

function ratioOf(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
}

function factorOf(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n : fallback
}

export function getSettings(): AppSettings {
  const row = getDb().get('SELECT value FROM settings WHERE key = ?', [KEY]) as
    | { value: string }
    | null
  if (!row) return structuredClone(DEFAULTS)
  try {
    return normalizeSettings(JSON.parse(row.value))
  } catch {
    return structuredClone(DEFAULTS)
  }
}

/** 库里已经落地的单据数——基准币一旦有账就只能锁死，改动前先问它 */
function bookedDocCount(): number {
  const one = (sql: string): number => {
    const r = getDb().get(sql) as { n: number | bigint } | null
    return Number(r?.n ?? 0)
  }
  return (
    one('SELECT COUNT(*) AS n FROM orders') +
    one('SELECT COUNT(*) AS n FROM quotations') +
    one('SELECT COUNT(*) AS n FROM sample_orders')
  )
}

/**
 * 保存前的把关。
 * 设置页是个表单，浏览器里的 input 什么都能塞进来（空串、负数、重复币种），
 * 以前直接落库，之后报表和单据按这些脏值算——所以校验收在服务层，
 * 界面绕过也好、将来多加一个入口也好，规则只有一份。
 */
function validateSettings(input: unknown): AppSettings {
  if (!input || typeof input !== 'object') throw new Error('设置内容读不出来，请刷新页面重试')
  const raw = input as Record<string, unknown>
  const company = (raw.company && typeof raw.company === 'object' ? raw.company : {}) as Record<string, unknown>
  const current = getSettings()

  const out: AppSettings = {
    company: {
      name: '',
      logoFile: textOf(company.logoFile).trim(),
      address: '',
      phone: '',
      email: '',
      website: ''
    },
    banks: [],
    operator: current.operator,
    piValidDays: current.piValidDays,
    defaultDepositRatio: current.defaultDepositRatio,
    remindConfirmDays: current.remindConfirmDays,
    remindPaymentDays: current.remindPaymentDays,
    remindBalanceDays: current.remindBalanceDays,
    remindShipDays: current.remindShipDays,
    grossWeightFactor: current.grossWeightFactor,
    baseCurrency: current.baseCurrency,
    // 这两项由备份服务写，设置页传什么都不认（不然一保存就把备份凭据抹了）
    lastBackupAt: current.lastBackupAt,
    lastBackupError: current.lastBackupError
  }

  for (const [key, label, limit] of TEXT_LIMITS) {
    const v = textOf(company[key]).trim()
    if (v.length > limit) throw new Error(`${label}太长了（最多 ${limit} 个字），印在单据抬头上会排不下`)
    out.company[key] = v
  }

  // 操作员不吃「没传就清空」那一套：别的入口保存设置（备份服务、测试）不该顺手把签字人抹掉
  if (raw.operator !== undefined) {
    const operator = textOf(raw.operator).trim()
    if (operator.length > 40) throw new Error('操作员名字太长了（最多 40 个字）')
    out.operator = operator
  }

  const banksRaw = Array.isArray(raw.banks) ? raw.banks : []
  const seen = new Set<Currency>()
  for (const b of banksRaw) {
    if (!b || typeof b !== 'object') throw new Error('收款账户里有看不懂的条目，请删掉重新添加')
    const bb = b as Record<string, unknown>
    if (!isCurrency(bb.currency)) throw new Error('收款账户的币种没选对，请从下拉里选一个')
    if (seen.has(bb.currency)) {
      throw new Error(`${bb.currency} 的收款账户加了两遍。同一币种只留一个，PI 才知道印哪个账号`)
    }
    seen.add(bb.currency)
    const bank: BankAccount = {
      currency: bb.currency,
      bankName: '',
      accountName: '',
      accountNo: '',
      swift: '',
      address: ''
    }
    for (const [key, label, limit] of BANK_TEXT_LIMITS) {
      const v = textOf(bb[key]).trim()
      if (v.length > limit) throw new Error(`${label}太长了（最多 ${limit} 个字）`)
      bank[key] = v
    }
    out.banks.push(bank)
  }

  for (const [key, label, min, max] of DAY_FIELDS) {
    const v = Number(raw[key])
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`${label}（天）要填 ${min}～${max} 之间的整数`)
    }
    out[key] = v
  }

  const ratio = Number(raw.defaultDepositRatio)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('默认定金比例只能在 0%～100% 之间')
  }
  out.defaultDepositRatio = ratio

  const factor = Number(raw.grossWeightFactor)
  if (!Number.isFinite(factor) || factor < 1 || factor > 3) {
    throw new Error('毛重系数得在 1～3 之间：毛重不会比净重还轻，也不该重到净重的三倍')
  }
  out.grossWeightFactor = factor

  if (!isCurrency(raw.baseCurrency)) throw new Error('基准币种没选对')
  if (raw.baseCurrency !== current.baseCurrency) {
    const booked = bookedDocCount()
    if (booked > 0) {
      throw new Error(
        `已经有 ${booked} 张单据按「${current.baseCurrency}」记账了，基准币不能换。` +
          `换基准币等于把历史账目全部重算一遍，待收、毛利、报表会集体错位且改不回来。` +
          `确实要换，先把旧账结清、导出台账，再重开一套数据。`
      )
    }
    out.baseCurrency = raw.baseCurrency
  }

  return out
}

/** 基准币是否已锁死：库里已经有单据记账了就不能换（保存时也会拦，这里给界面提前置灰） */
export function baseCurrencyLocked(): boolean {
  return bookedDocCount() > 0
}

export function saveSettings(s: AppSettings): AppSettings {
  const merged = validateSettings(s)
  getDb().run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [KEY, JSON.stringify(merged)]
  )
  return merged
}

/** 备份服务专用：盖一个「最近成功备份于」的时间戳，同时清掉上次的失败提示 */
export function markBackupOk(iso: string): void {
  patchServerOwned({ lastBackupAt: iso, lastBackupError: null })
}

/** 备份服务专用：记下这次为什么没备成（失败不覆盖上一次成功的时刻，那是凭据） */
export function markBackupFail(message: string): void {
  patchServerOwned({ lastBackupError: message })
}

function patchServerOwned(patch: Partial<Pick<AppSettings, 'lastBackupAt' | 'lastBackupError'>>): void {
  const s = getSettings()
  const merged: AppSettings = { ...s, ...patch }
  getDb().run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [KEY, JSON.stringify(merged)]
  )
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
