import { useEffect, useState } from 'react'
import { useToast } from '../ui'
import { imageUrl } from '../imageUrl'
import { CURRENCIES, type Currency } from '../../../shared/types'
import type { UpdateStatus } from '../../../shared/api'

export default function Settings() {
  const toast = useToast()
  const [s, setS] = useState<any>(null)
  const [backupPath, setBackupPath] = useState('')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [dataDir, setDataDir] = useState('')
  const [backupsDir, setBackupsDir] = useState('')

  useEffect(() => {
    void window.api.settings.get().then(setS)
    void window.api.app.dataDir().then(setDataDir)
    void window.api.app.backupsDir().then(setBackupsDir)
    // 初始拿一次当前版本，避免"检查更新"按钮因为 update 为 null 而一直禁用
    void window.api.updater.version().then((v) => {
      setUpdate((prev) => ({ status: 'idle', currentVersion: v, ...(prev ?? {}) }))
    })
  }, [])

  // 订阅自动更新事件
  useEffect(() => {
    return window.api.updater.on((info) => setUpdate(info))
  }, [])

  if (!s) return <div className="content">加载中…</div>

  const save = async () => {
    try {
      const r = await window.api.settings.save(s)
      setS(r)
      toast('设置已保存')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const setCompany = (k: string, v: string) =>
    setS({ ...s, company: { ...s.company, [k]: v } })

  const setBank = (currency: Currency, k: string, v: string) =>
    setS({
      ...s,
      banks: s.banks.map((b: any) => (b.currency === currency ? { ...b, [k]: v } : b))
    })

  const addBank = () =>
    setS({
      ...s,
      banks: [...s.banks, { currency: 'USD', bankName: '', accountName: '', accountNo: '', swift: '', address: '' }]
    })

  const removeBank = (currency: Currency) =>
    setS({ ...s, banks: s.banks.filter((b: any) => b.currency !== currency) })

  const importLogo = async () => {
    const name = await window.api.images.importLogo()
    if (name) {
      setCompany('logoFile', name)
      toast('Logo 已导入，记得保存设置')
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>设置</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={save}>
          保存设置
        </button>
      </div>

      <div className="content">
        <div className="card">
          <div className="card-head">
            <h2>公司信息</h2>
            <div className="spacer" />
            <span className="faint">打印在 PI / PL 抬头</span>
          </div>
          <div className="card-body">
            <div className="field">
              <label>公司名称</label>
              <input
                className="w-full"
                value={s.company.name}
                onChange={(e) => setCompany('name', e.target.value)}
              />
            </div>
            <div className="field">
              <label>地址</label>
              <input
                className="w-full"
                value={s.company.address}
                onChange={(e) => setCompany('address', e.target.value)}
              />
            </div>
            <div className="field-row-3">
              <div className="field">
                <label>电话</label>
                <input
                  className="w-md"
                  value={s.company.phone}
                  onChange={(e) => setCompany('phone', e.target.value)}
                />
              </div>
              <div className="field">
                <label>邮箱</label>
                <input
                  className="w-md"
                  value={s.company.email}
                  onChange={(e) => setCompany('email', e.target.value)}
                />
              </div>
              <div className="field">
                <label>网站</label>
                <input
                  className="w-md"
                  value={s.company.website}
                  onChange={(e) => setCompany('website', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>公司 Logo</label>
              <div className="row">
                {s.company.logoFile ? (
                  <div className="img-thumb" style={{ width: 140, height: 60 }}>
                    <img src={imageUrl(s.company.logoFile)} alt="logo" />
                  </div>
                ) : null}
                <button className="btn" onClick={importLogo}>
                  {s.company.logoFile ? '更换 Logo' : '导入 Logo'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>收款账户</h2>
            <div className="spacer" />
            <button className="btn sm" onClick={addBank}>
              + 添加账户
            </button>
          </div>
          <div className="card-body">
            {s.banks.length === 0 ? (
              <div className="hint">还没有银行账户。添加后 PI 会自动印上收款信息。</div>
            ) : (
              s.banks.map((b: any) => (
                <div key={b.currency} style={{ marginBottom: 16 }}>
                  <div className="row mb">
                    <strong>{b.currency}</strong>
                    <div className="spacer" />
                    <button className="btn sm ghost danger" onClick={() => removeBank(b.currency)}>
                      移除
                    </button>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label>账户名</label>
                      <input
                        className="w-lg"
                        value={b.accountName}
                        onChange={(e) => setBank(b.currency, 'accountName', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>银行名称</label>
                      <input
                        className="w-lg"
                        value={b.bankName}
                        onChange={(e) => setBank(b.currency, 'bankName', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label>账号</label>
                      <input
                        className="w-md"
                        value={b.accountNo}
                        onChange={(e) => setBank(b.currency, 'accountNo', e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>SWIFT</label>
                      <input
                        className="w-md"
                        value={b.swift}
                        onChange={(e) => setBank(b.currency, 'swift', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field">
                    {/* R4-S6：银行地址会印在 PI 上给客户打款，原来 320px 把尾巴硬切了，
                        加宽到和「银行名称」同宽（w-lg 520px） */}
                    <label>银行地址</label>
                    <input
                      className="w-lg"
                      value={b.address}
                      onChange={(e) => setBank(b.currency, 'address', e.target.value)}
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>业务默认值</h2>
          </div>
          <div className="card-body">
            <div className="field-row-3">
              <div className="field">
                <label>PI 有效期（天）</label>
                <input
                  type="number"
                  value={s.piValidDays}
                  onChange={(e) => setS({ ...s, piValidDays: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>默认定金比例</label>
                <select
                  value={String(s.defaultDepositRatio)}
                  onChange={(e) => setS({ ...s, defaultDepositRatio: Number(e.target.value) })}
                >
                  <option value="0.2">20%</option>
                  <option value="0.3">30%</option>
                  <option value="0.4">40%</option>
                  <option value="0.5">50%</option>
                </select>
              </div>
              <div className="field">
                <label>基准币种</label>
                <select
                  value={s.baseCurrency}
                  onChange={(e) => setS({ ...s, baseCurrency: e.target.value })}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field-row-3">
              <div className="field">
                <label>催确认阈值（天）</label>
                <input
                  type="number"
                  value={s.remindConfirmDays}
                  onChange={(e) => setS({ ...s, remindConfirmDays: Number(e.target.value) })}
                />
                <div className="hint">PI 发出超过该天数未确认则提醒</div>
              </div>
              <div className="field">
                <label>催款阈值（天）</label>
                <input
                  type="number"
                  value={s.remindPaymentDays}
                  onChange={(e) => setS({ ...s, remindPaymentDays: Number(e.target.value) })}
                />
                <div className="hint">客户确认后超过该天数未收款则提醒</div>
              </div>
              <div className="field">
                <label>催尾款阈值（天）</label>
                <input
                  type="number"
                  value={s.remindBalanceDays}
                  onChange={(e) => setS({ ...s, remindBalanceDays: Number(e.target.value) })}
                />
                <div className="hint">已收定金但未收齐，超过该天数提醒催尾款</div>
              </div>
            </div>

            <div className="field-row-3">
              <div className="field">
                <label>出货提醒提前（天）</label>
                <input
                  type="number"
                  value={s.remindShipDays}
                  onChange={(e) => setS({ ...s, remindShipDays: Number(e.target.value) })}
                />
                <div className="hint">距预计出货日该天数时提醒备货</div>
              </div>
              <div className="field">
                <label>毛重系数</label>
                <input
                  type="number"
                  step="0.01"
                  value={s.grossWeightFactor}
                  onChange={(e) => setS({ ...s, grossWeightFactor: Number(e.target.value) })}
                />
                <div className="hint">装箱单未填毛重时按此系数估算</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>数据备份</h2>
          </div>
          <div className="card-body">
            <div className="hint" style={{ marginBottom: 8 }}>
              主数据库：<span className="mono">{dataDir ? `${dataDir}\\ikanbot.db` : '…'}</span>
            </div>
            <div className="hint" style={{ marginBottom: 8 }}>
              图片目录：<span className="mono">{dataDir ? `${dataDir}\\images` : '…'}</span>
            </div>
            <div className="hint" style={{ marginBottom: 12 }}>
              备份目录：<span className="mono">{backupsDir || '…'}</span>
            </div>
            <div className="hint">
              程序每天启动时会自动备份一次，保留最近 30 份。
            </div>
            <div className="row">
              <button
                className="btn primary"
                onClick={async () => {
                  const f = await window.api.backup.create()
                  if (f) {
                    setBackupPath(f)
                    toast('备份已创建')
                  }
                }}
              >
                立即备份
              </button>
              <button className="btn" onClick={async () => {
                const d = await window.api.backup.reveal()
                if (d) setBackupPath(d)
              }}>
                打开备份目录
              </button>
            </div>
            {backupPath ? <div className="hint mono">{backupPath}</div> : null}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>软件更新</h2>
          </div>
          <div className="card-body">
            <div className="field-row">
              <div className="field">
                <label>当前版本</label>
                <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 16 }}>
                    {update?.currentVersion ?? '—'}
                  </span>
                  <button
                    className="btn"
                    disabled={update?.status === 'checking' || update?.status === 'downloading'}
                    onClick={async () => {
                      const r = await window.api.updater.check()
                      setUpdate(r)
                      if (r.status === 'error' && r.message) toast(r.message, 'error')
                    }}
                  >
                    检查更新
                  </button>
                  {update?.status === 'available' ? (
                    <button
                      className="btn primary"
                      onClick={async () => {
                        const r = await window.api.updater.download()
                        setUpdate(r)
                      }}
                    >
                      下载 v{update.version}
                    </button>
                  ) : null}
                  {update?.status === 'downloaded' ? (
                    <button
                      className="btn primary"
                      onClick={() => void window.api.updater.install()}
                    >
                      重启安装 v{update.version}
                    </button>
                  ) : null}
                </div>
                <div className="hint">
                  有新版时会显示下载按钮，下载完点"重启安装"，程序会自己关了自己装完再打开。
                </div>
              </div>
            </div>

            {/* 状态反馈 */}
            {update?.status === 'checking' ? (
              <div className="alert info">正在检查更新…</div>
            ) : null}
            {update?.status === 'not-available' ? (
              <div className="alert info">
                已经是最新版本（v{update.version ?? update.currentVersion}）。
              </div>
            ) : null}
            {update?.status === 'available' ? (
              <div className="alert warn">
                发现新版本 <strong>v{update.version}</strong>
                {update.releaseDate ? <span className="faint">（{String(update.releaseDate).slice(0, 10)}）</span> : null}
                {update.releaseNotes ? (
                  <div className="hint" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {update.releaseNotes}
                  </div>
                ) : null}
              </div>
            ) : null}
            {update?.status === 'downloading' ? (
              <div className="alert info">
                <div style={{ marginBottom: 6 }}>
                  正在下载 v{update.version ?? ''}…{' '}
                  <strong>{update.percent ?? 0}%</strong>
                  {update.transferred != null && update.total != null ? (
                    <span className="faint">
                      {' '}
                      （{Math.round(update.transferred / 1024 / 1024)}MB /{' '}
                      {Math.round(update.total / 1024 / 1024)}MB）
                    </span>
                  ) : null}
                </div>
                <div
                  style={{
                    height: 6,
                    background: '#e2e6ee',
                    borderRadius: 3,
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${update.percent ?? 0}%`,
                      height: '100%',
                      background: 'var(--accent)',
                      transition: 'width .2s'
                    }}
                  />
                </div>
              </div>
            ) : null}
            {update?.status === 'downloaded' ? (
              <div className="alert info">
                已下载完成，点上面"重启安装 v{update.version}"即可。
              </div>
            ) : null}
            {update?.status === 'error' ? (
              <div className="alert warn">{update.message ?? '出错了'}</div>
            ) : null}

            <div className="hint" style={{ marginTop: 10 }}>
              更新来自 GitHub Releases，需要能访问 github.com。如果下载慢，
              <button
                className="btn sm"
                style={{ marginLeft: 6 }}
                onClick={() =>
                  void window.api.shell.openExternal('https://github.com/chenpeigen2/IKanBot/releases')
                }
              >
                去 GitHub 手动下载
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
