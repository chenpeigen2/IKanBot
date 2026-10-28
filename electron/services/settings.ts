import { coreDb, dataDir, getDb, imagesDir } from '../db'
import type { AppSettings, BankAccount, Currency } from '../../src/shared/types'
import { parseSettings, settingsCore } from '../../core/settings'

const core = settingsCore(coreDb)

const KEY = 'app_settings'

/**
 * 同步读取：订单、报表、打印这些服务还在同步函数里调它，一时换不成 await。
 * 业务口径（默认值、脏数据兜底）仍在 core/settings.ts，这里只是把那一行 SELECT
 * 走同步驱动取出来——不是第二份实现。
 */
export function getSettings(): AppSettings {
  const row = getDb().get('SELECT value FROM settings WHERE key = ?', [KEY]) as { value: string } | null
  return parseSettings(row?.value)
}

export function saveSettings(s: AppSettings): Promise<AppSettings> {
  return core.save(s)
}

/** 基准币是否已锁死：库里已经有单据记账了就不能换（保存时也会拦，这里给界面提前置灰） */
export function baseCurrencyLocked(): Promise<boolean> {
  return core.baseCurrencyLocked()
}

/** 备份服务专用：盖一个「最近成功备份于」的时间戳，同时清掉上次的失败提示 */
export function markBackupOk(iso: string): Promise<void> {
  return core.patchBackup({ lastBackupAt: iso, lastBackupError: null })
}

/** 备份服务专用：记下这次为什么没备成（失败不覆盖上一次成功的时刻，那是凭据） */
export function markBackupFail(message: string): Promise<void> {
  return core.patchBackup({ lastBackupError: message })
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
