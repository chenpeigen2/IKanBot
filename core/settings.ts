/**
 * 系统设置：桌面（本机 SQLite）与后端服务（HTTP）共用这一份实现。
 *
 * 设置是「一台机器上的整体口径」：公司抬头、收款账户、提醒阈值、基准币。
 * 以前这些校验写在 electron/services 里，后端要读同一份配置就只能抄一遍；
 * 现在 SQL、归一化、守门都在这里，两边各自把 Db 与图片目录接进来。
 */
import { CURRENCIES, type AppSettings, type BankAccount, type Currency } from '../src/shared/types'
import { BizError } from '../src/shared/errors'
import type { Db } from './db'
import { LATEST_DB_VERSION } from '../electron/db/schema'

export const SETTINGS_DEFAULTS: AppSettings = {
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

/**
 * 备份的两个戳单独存一行。
 *
 * 以前它们混在整份设置 JSON 里：每日备份收尾要「读出来 → 盖个戳 → 写回去」，
 * 而这份读-改-写只要在并发里被设置页的保存插一杠，就会把用户刚填的抬头、账户、
 * 阈值整份盖回旧值（备份服务写的是它读到的那个快照）。反过来设置页保存也带着
 * 它读到的旧戳写回去，谁后写谁说了算。
 * 现在两边各写各的行：设置页只写正文（write 里剥掉这两个字段），
 * 备份只在 backup_state 这一行上做读-改-写。
 */
export const BACKUP_STATE_KEY = 'backup_state'

/**
 * 把 backup_state 那一行里的戳盖到设置对象上。
 * 没落过这一行（升级前的库）就沿用正文里那份——老数据里戳还在老位置，不能丢。
 */
export function mergeBackupStamps(s: AppSettings, text: string | null | undefined): AppSettings {
  if (!text) return s
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return s
  }
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  return {
    ...s,
    lastBackupAt: typeof p['lastBackupAt'] === 'string' ? p['lastBackupAt'] : null,
    lastBackupError: typeof p['lastBackupError'] === 'string' ? p['lastBackupError'] : null
  }
}

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
export function normalizeSettings(parsed: unknown): AppSettings {
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
    piValidDays: dayOf(p.piValidDays, SETTINGS_DEFAULTS.piValidDays, 1, 365),
    defaultDepositRatio: ratioOf(p.defaultDepositRatio, SETTINGS_DEFAULTS.defaultDepositRatio),
    remindConfirmDays: dayOf(p.remindConfirmDays, SETTINGS_DEFAULTS.remindConfirmDays, 0, 365),
    remindPaymentDays: dayOf(p.remindPaymentDays, SETTINGS_DEFAULTS.remindPaymentDays, 0, 365),
    remindBalanceDays: dayOf(p.remindBalanceDays, SETTINGS_DEFAULTS.remindBalanceDays, 0, 365),
    remindShipDays: dayOf(p.remindShipDays, SETTINGS_DEFAULTS.remindShipDays, 0, 90),
    grossWeightFactor: factorOf(p.grossWeightFactor, SETTINGS_DEFAULTS.grossWeightFactor),
    baseCurrency: isCurrency(p.baseCurrency) ? p.baseCurrency : SETTINGS_DEFAULTS.baseCurrency,
    operator: textOf(p.operator).trim().slice(0, 40),
    lastBackupAt: typeof p.lastBackupAt === 'string' ? p.lastBackupAt : null,
    lastBackupError: typeof p.lastBackupError === 'string' ? p.lastBackupError : null
  }
}

/**
 * 库里那一列 JSON 文本 → 设置对象。
 *
 * 桌面端有一批同步服务（订单、报表）还在直接读它，所以解析这一半是纯函数：
 * 桌面把同步取到的那行文本递进来，后端把异步取到的递进来，退回默认值的行为只有一处。
 */
export function parseSettings(value: string | null | undefined): AppSettings {
  if (!value) return structuredClone(SETTINGS_DEFAULTS)
  try {
    return normalizeSettings(JSON.parse(value))
  } catch {
    return structuredClone(SETTINGS_DEFAULTS)
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

export function settingsCore(db: Db) {
  async function get(): Promise<AppSettings> {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [KEY])
    const backup = await db.get('SELECT value FROM settings WHERE key = ?', [BACKUP_STATE_KEY])
    return mergeBackupStamps(
      parseSettings(typeof row?.['value'] === 'string' ? (row['value'] as string) : null),
      typeof backup?.['value'] === 'string' ? (backup['value'] as string) : null
    )
  }

  /** 库里已经落地的单据数——基准币一旦有账就只能锁死，改动前先问它 */
  async function bookedDocCount(): Promise<number> {
    const one = async (table: string): Promise<number> => {
      const r = await db.get(`SELECT COUNT(*) AS n FROM ${table}`)
      return Number(r?.['n'] ?? 0)
    }
    return (await one('orders')) + (await one('quotations')) + (await one('sample_orders'))
  }

  /**
   * 保存前的把关。
   * 设置页是个表单，浏览器里的 input 什么都能塞进来（空串、负数、重复币种），
   * 以前直接落库，之后报表和单据按这些脏值算——所以校验收在服务层，
   * 界面绕过也好、将来多加一个入口也好，规则只有一份。
   */
  async function validate(rawInput: unknown): Promise<AppSettings> {
    if (!rawInput || typeof rawInput !== 'object') throw new BizError('设置内容读不出来，请刷新页面重试')
    const raw = rawInput as Record<string, unknown>
    const company = (raw['company'] && typeof raw['company'] === 'object' ? raw['company'] : {}) as Record<
      string,
      unknown
    >
    const current = await get()

    const out: AppSettings = {
      company: {
        name: '',
        logoFile: textOf(company['logoFile']).trim(),
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
      if (v.length > limit) throw new BizError(`${label}太长了（最多 ${limit} 个字），印在单据抬头上会排不下`)
      out.company[key] = v
    }

    // 操作员不吃「没传就清空」那一套：别的入口保存设置（备份服务、测试）不该顺手把签字人抹掉
    if (raw['operator'] !== undefined) {
      const operator = textOf(raw['operator']).trim()
      if (operator.length > 40) throw new BizError('操作员名字太长了（最多 40 个字）')
      out.operator = operator
    }

    const banksRaw = Array.isArray(raw['banks']) ? raw['banks'] : []
    const seen = new Set<Currency>()
    for (const b of banksRaw) {
      if (!b || typeof b !== 'object') throw new BizError('收款账户里有看不懂的条目，请删掉重新添加')
      const bb = b as Record<string, unknown>
      if (!isCurrency(bb['currency'])) throw new BizError('收款账户的币种没选对，请从下拉里选一个')
      if (seen.has(bb['currency'])) {
        throw new BizError(
          `${bb['currency']} 的收款账户加了两遍。同一币种只留一个，PI 才知道印哪个账号`
        )
      }
      seen.add(bb['currency'])
      const bank: BankAccount = {
        currency: bb['currency'],
        bankName: '',
        accountName: '',
        accountNo: '',
        swift: '',
        address: ''
      }
      for (const [key, label, limit] of BANK_TEXT_LIMITS) {
        const v = textOf(bb[key]).trim()
        if (v.length > limit) throw new BizError(`${label}太长了（最多 ${limit} 个字）`)
        bank[key] = v
      }
      out.banks.push(bank)
    }

    for (const [key, label, min, max] of DAY_FIELDS) {
      const v = Number(raw[key])
      if (!Number.isInteger(v) || v < min || v > max) {
        throw new BizError(`${label}（天）要填 ${min}～${max} 之间的整数`)
      }
      out[key] = v
    }

    const ratio = Number(raw['defaultDepositRatio'])
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new BizError('默认定金比例只能在 0%～100% 之间')
    }
    out.defaultDepositRatio = ratio

    const factor = Number(raw['grossWeightFactor'])
    if (!Number.isFinite(factor) || factor < 1 || factor > 3) {
      throw new BizError('毛重系数得在 1～3 之间：毛重不会比净重还轻，也不该重到净重的三倍')
    }
    out.grossWeightFactor = factor

    if (!isCurrency(raw['baseCurrency'])) throw new BizError('基准币种没选对')
    if (raw['baseCurrency'] !== current.baseCurrency) {
      const booked = await bookedDocCount()
      if (booked > 0) {
        throw new BizError(
          `已经有 ${booked} 张单据按「${current.baseCurrency}」记账了，基准币不能换。` +
            `换基准币等于把历史账目全部重算一遍，待收、毛利、报表会集体错位且改不回来。` +
            `确实要换，先把旧账结清、导出台账，再重开一套数据。`
        )
      }
      out.baseCurrency = raw['baseCurrency']
    }

    return out
  }

  async function write(s: AppSettings): Promise<void> {
    // 正文里不落戳：戳归 backup_state，设置页保存不该顺手把备份凭据写成旧值
    const main = { ...s } as Partial<AppSettings>
    delete main.lastBackupAt
    delete main.lastBackupError
    // upsert(overwrite)：设置行只有一行，整格换新 JSON（SQLite/MySQL 同一个原语，方言不在 core）
    await db.upsert({
      table: 'settings',
      keyCol: 'key',
      valueCol: 'value',
      key: KEY,
      value: JSON.stringify(main),
      mode: 'overwrite'
    })
  }

  async function save(rawInput: unknown): Promise<AppSettings> {
    const merged = await validate(rawInput)
    await write(merged)
    return merged
  }

  /** 基准币是否已锁死：库里已经有单据记账了就不能换（保存时也会拦，这里给界面提前置灰） */
  async function baseCurrencyLocked(): Promise<boolean> {
    return (await bookedDocCount()) > 0
  }

  /**
   * 备份服务专用：只盖自己那一两个戳。
   *
   * 只动 backup_state 这一行，正文一个字都不碰——所以哪怕设置页正在保存、
   * 哪怕正文那块 JSON 已经读不出来，一次备份收尾也不会把用户填的东西换成别的。
   */
  async function patchBackup(patch: Partial<Pick<AppSettings, 'lastBackupAt' | 'lastBackupError'>>): Promise<void> {
    const cur = await get()
    const next = { lastBackupAt: cur.lastBackupAt, lastBackupError: cur.lastBackupError, ...patch }
    await db.upsert({
      table: 'settings',
      keyCol: 'key',
      valueCol: 'value',
      key: BACKUP_STATE_KEY,
      value: JSON.stringify(next),
      mode: 'overwrite'
    })
  }

  /**
   * 数据自检（R83，探针闸的用户主动版）：不等备份/恢复，随时能问「我的数据健康吗」。
   * 三道闸与 restore/backup 的探针同一套口径（自检/版本/核心表在不在）——
   * quick_check 不过 = 库损坏；版本超前 = 被新版程序写过；核心表缺 = 结构异常。
   * 12 表行数顺带给（搬迁对账同款清单），用户看一眼就知道「账还在」。
   */
  async function dataHealthCheck(): Promise<{
    ok: boolean
    quickCheck: string
    version: number
    tables: Record<string, number>
    /** 人话问题清单（R84 复验挂账）：红框里给「怎么办」先行——quick_check 原文留在
     *  quickCheck 字段、红框的技术细节行照给，供技术支持排查 */
    problems: string[]
  }> {
    const check = (await db.get('PRAGMA quick_check')) as { quick_check?: string } | null
    const quickCheck = String(check?.quick_check ?? '')
    const ver = Number((await db.get('PRAGMA user_version'))?.['user_version'] ?? 0)
    const tables: Record<string, number> = {}
    // 缺表/结构坏：COUNT 会抛英文 SQLite 错（R84 e2e 实锤）——记成人话问题，不让英文上界面
    const problems: string[] = []
    for (const t of ['orders', 'order_items', 'customers', 'products', 'quotations', 'quotation_items', 'sample_orders', 'sample_order_items', 'payments', 'order_events', 'packing_lists', 'credit_applications']) {
      try {
        const r = (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)) as { n?: number } | null
        tables[t] = Number(r?.n ?? 0)
      } catch {
        problems.push(`核心表 ${t} 读不出来（数据结构异常）——请先不要录单，立即联系技术支持。`)
        tables[t] = -1
      }
    }
    // 三道闸的人话问题清单（R84）：红框里说「怎么办」，人话先行；quickCheck 的英文原文
    // 留在原字段、界面在红框的技术细节行照给（R83 复验认可原文可见）——截图发给技术支持
    // 就够排查，不用再来回问
    if (quickCheck !== 'ok') {
      problems.push(
        quickCheck === ''
          ? '数据库自检没有响应——库文件可能损坏，请先不要录单，立即联系技术支持。'
          : '数据库文件自检没通过（库可能损坏）——请先不要录单，立即联系技术支持。'
      )
      // R86：freelist/结构级损坏但表全读得动 → 备份的 VACUUM INTO 快照会重建出干净库
      // （行为锁：e2e R86「坏库打出来的包是重建的干净库」）。说破这条修复路，用户才知道
      // 「立即备份」在这种坏法下还有用；表读不动的深度损坏不给这句——快照多半也打不出来
      // /会被自检拒（R86「降级直拷」那条锁着），照旧只说联系技术支持
      if (quickCheck !== '' && !problems.some((p) => p.startsWith('核心表'))) {
        problems.push(
          '好消息：点「立即备份」打出来的包是重建过的干净库——把它恢复到新程序里，库就修好了。' +
            '活库本身还坏着：请先不要录单，备份完成后立即联系技术支持。'
        )
      }
    }
    if (ver > LATEST_DB_VERSION) {
      problems.push(
        `这份数据来自更新的程序版本（数据格式 v${ver}，当前只认到 v${LATEST_DB_VERSION}）——` +
          `请先不要录单，把程序升级到最新版再打开。`
      )
    }
    const ok = problems.length === 0
    return { ok, quickCheck, version: ver, tables, problems }
  }

  return { get, save, baseCurrencyLocked, patchBackup, dataHealthCheck }
}

export type SettingsCore = ReturnType<typeof settingsCore>
