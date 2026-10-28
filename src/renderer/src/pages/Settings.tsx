import { useEffect, useState } from 'react'
import { useToast, Card, Button, clientKey, LoadError } from '../ui'
import { imageUrl } from '../imageUrl'
import { CURRENCIES } from '../../../shared/types'
import type { BackupPreview, DataPaths, DataSourceState, RemoteProbe, UpdateStatus } from '../../../shared/api'

/** 把 ISO 时刻说成人话：今天的说几点，更早的说几天前 */
function sinceWords(iso: string | null): string {
  if (!iso) return '还没有过成功备份'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '备份时间看不懂'
  const mins = Math.floor((Date.now() - t.getTime()) / 60000)
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  if (mins < 1) return '就在刚刚'
  if (mins < 60) return `${mins} 分钟前`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} 小时前`
  const days = Math.floor(mins / (60 * 24))
  return `${days} 天前（${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(
    t.getDate()
  ).padStart(2, '0')} ${clock}）`
}

const MB = 1024 * 1024

/**
 * 收款账户行的前端身份。
 * 服务端存回来的账户没有 id，删掉中间一行时数组整体前移，
 * 用下标当 key 会让下一行的半个字、焦点全落到刚删掉的那格上（E8 同款病）。
 * uid 只在界面上用，settings.save 服务端按字段白名单收，多出来的 uid 落不了库。
 */
function withBankUids(r: any): any {
  if (!r) return r
  return { ...r, banks: (r.banks ?? []).map((b: any) => ({ uid: clientKey(), ...b })) }
}

export default function Settings() {
  const toast = useToast()
  const [s, setS] = useState<any>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [paths, setPaths] = useState<DataPaths | null>(null)
  const [baseLocked, setBaseLocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastBackupFile, setLastBackupFile] = useState('')
  const [restorePath, setRestorePath] = useState('')
  const [restoreInfo, setRestoreInfo] = useState<BackupPreview | null>(null)
  const [restoring, setRestoring] = useState(false)
  /** 设置读不出来时别停在「加载中…」：给一句话和一次重试 */
  const [loadError, setLoadError] = useState('')
  /** 数据来源：本机 / 后端。与上面那份设置分开存，它不在库里 */
  const [source, setSource] = useState<DataSourceState | null>(null)
  const [urlDraft, setUrlDraft] = useState('')
  const [probe, setProbe] = useState<RemoteProbe | null>(null)
  const [probing, setProbing] = useState(false)

  const loadSettings = async () => {
    try {
      setS(withBankUids(await window.api.settings.get()))
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '设置没读出来')
    }
  }

  const loadSource = async () => {
    try {
      const v = await window.api.mode.get()
      setSource(v)
      setUrlDraft(v.remoteUrl)
    } catch (e) {
      toast(`数据来源没读出来：${(e as Error).message}`, 'error')
    }
  }

  useEffect(() => {
    void loadSettings()
    // 这三样都是页面骨架信息：读不出来要吭声，不能默默显示默认值
    const fail = (what: string) => (e: unknown) => toast(`${what}没读出来：${(e as Error).message}`, 'error')
    window.api.settings.baseLocked().then(setBaseLocked, fail('基准币种状态'))
    window.api.app.paths().then(setPaths, fail('数据目录'))
    // 一进来先问主进程要当前状态：进度那一份只认主进程存的，页面刷新也不会丢
    window.api.updater.state().then(setUpdate, fail('更新状态'))
    void loadSource()
  }, [])

  const switchMode = async (mode: 'local' | 'remote') => {
    try {
      const v = await window.api.mode.set({ mode, remoteUrl: urlDraft })
      setSource(v)
      setUrlDraft(v.remoteUrl)
      setProbe(null)
      toast(
        mode === 'remote'
          ? '已切到后端模式：客户档案、商品与系统设置改由后端提供，其它功能仍在本机'
          : '已切回本机模式，数据再次来自这台电脑'
      )
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const saveUrl = async () => {
    try {
      const v = await window.api.mode.set({ remoteUrl: urlDraft })
      setSource(v)
      setUrlDraft(v.remoteUrl)
      setProbe(null)
      toast('后端地址已保存')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const testConn = async () => {
    setProbing(true)
    try {
      const r = await window.api.mode.test(urlDraft)
      setProbe(r)
      toast(r.message, r.ok ? 'ok' : 'error')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setProbing(false)
    }
  }

  // 订阅自动更新事件
  useEffect(() => {
    return window.api.updater.on((info) => setUpdate(info))
  }, [])

  /**
   * 数据来源卡片单独拿出来：设置本身读不出来时（后端掉线、地址写错），
   * 这恰恰是最需要它的时候——把人挡在「加载失败」页面里，就再也切不回本机了。
   */
  const sourceCard = (
    <Card title="数据来源" actions={<span className="faint">决定单据读写哪一份数据</span>}>
      {!source ? (
        <div className="hint">数据来源读取中…</div>
      ) : (
        <>
          <div className="field">
            <label>当前使用</label>
            <select
              value={source.mode}
              disabled={source.envLocked}
              onChange={(e) => void switchMode(e.target.value as 'local' | 'remote')}
            >
              <option value="local">本机（这台电脑上的数据库）</option>
              <option value="remote">后端服务（局域网 / 云上的 IKanBot 后端）</option>
            </select>
            <div className="hint">
              本机模式数据就在这台电脑上；后端模式把读写交给后端服务，几台电脑可以共用同一份账。
            </div>
          </div>

          <div className="field">
            <label>后端地址</label>
            <div className="row">
              <input
                className="w-lg"
                value={urlDraft}
                disabled={source.envLocked}
                placeholder="http://192.168.1.10:8787"
                onChange={(e) => {
                  setUrlDraft(e.target.value)
                  setProbe(null)
                }}
              />
              <Button onClick={saveUrl} disabled={source.envLocked}>
                保存地址
              </Button>
              <Button onClick={testConn} disabled={probing || !urlDraft.trim()}>
                {probing ? '连接中…' : '测试连接'}
              </Button>
            </div>
            {probe ? (
              <div className={`alert ${probe.ok ? 'info' : 'warn'}`} style={{ marginTop: 8 }}>
                {probe.message}
              </div>
            ) : null}
          </div>

          {source.envLocked ? (
            <div className="alert warn">
              这次的来源由环境变量 IKAN_MODE / IKAN_REMOTE_URL 指定，上面改了也不生效——去掉变量重启后，以这里的设置为准。
            </div>
          ) : null}

          {source.mode === 'remote' ? (
            <div className="alert warn">
              现在是<strong>后端模式</strong>：客户档案、商品与系统设置读写后端那份数据（已搬到后端{' '}
              {source.covered} / {source.total} 个接口）。订单、打样、报价、单据这些还没搬，点了会当场报错，绝不会悄悄改本机那一份。
              要干正经活，先切回本机。
            </div>
          ) : (
            <div className="hint">
              后端目前接好了 {source.covered} / {source.total} 个接口（客户档案、商品、系统设置）。其余功能搬完之前，后端模式只适合试接口。
            </div>
          )}
        </>
      )}
    </Card>
  )

  if (!s) {
    return (
      <div className="content">
        {loadError ? (
          <>
            <LoadError what="设置" message={loadError} onRetry={() => void loadSettings()} />
            {sourceCard}
          </>
        ) : (
          <div className="empty loading">加载中…</div>
        )}
      </div>
    )
  }

  const save = async () => {
    try {
      const r = await window.api.settings.save(s)
      setS(withBankUids(r))
      toast('设置已保存')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const setCompany = (k: string, v: string) => setS({ ...s, company: { ...s.company, [k]: v } })

  // 收款账户按 uid 改：币种可能被历史数据加过两遍，用币种当 key 会一改改两行；用下标又会在删中间一行时串到下一行
  const setBank = (uid: string, k: string, v: string) =>
    setS({ ...s, banks: s.banks.map((b: any) => (b.uid === uid ? { ...b, [k]: v } : b)) })

  const addBank = () => {
    const used = new Set<string>(s.banks.map((b: any) => b.currency))
    const free = CURRENCIES.find((c) => !used.has(c))
    if (!free) {
      toast('五个币种都已经有了，先移除一个再加', 'error')
      return
    }
    setS({
      ...s,
      banks: [
        ...s.banks,
        { uid: clientKey(), currency: free, bankName: '', accountName: '', accountNo: '', swift: '', address: '' }
      ]
    })
  }

  const removeBank = (uid: string) => setS({ ...s, banks: s.banks.filter((b: any) => b.uid !== uid) })

  const importLogo = async () => {
    const name = await window.api.images.importLogo()
    if (name) {
      setCompany('logoFile', name)
      toast('Logo 已导入，记得保存设置')
    }
  }

  const runBackup = async () => {
    setBusy(true)
    try {
      const f = await window.api.backup.create()
      setLastBackupFile(f)
      // 备份时间戳是备份服务写的，要拿回来才能刷新「最近一次成功备份」。
      // 只合并这两个服务端字段：以前整份设置覆盖回表单，用户改到一半的条款会被冲掉。
      const fresh = await window.api.settings.get()
      setS((prev: any) =>
        prev ? { ...prev, lastBackupAt: fresh.lastBackupAt, lastBackupError: fresh.lastBackupError } : prev
      )
      toast('备份已创建')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const chooseRestoreFile = async () => {
    try {
      const f = await window.api.backup.pick()
      if (!f) return
      setRestorePath(f)
      setRestoreInfo(await window.api.backup.inspect(f))
    } catch (e) {
      setRestorePath('')
      setRestoreInfo(null)
      toast((e as Error).message, 'error')
    }
  }

  const doRestore = async () => {
    if (!restoreInfo) return
    const when = restoreInfo.takenAt ? new Date(restoreInfo.takenAt).toLocaleString() : '时间未知'
    const summary =
      `要用这一份恢复：\n` +
      `  备份时间：${when}\n` +
      `  订单 ${restoreInfo.orderCount ?? '?'} 张 / 收款 ${restoreInfo.paymentCount ?? '?'} 笔 / 文件 ${restoreInfo.entryCount} 个\n\n` +
      `现在的订单、图片、单据存档会被整体替换成这一份的内容（当前数据会先自动备份一份，选错了还能退回来）。\n` +
      `确定要替换吗？程序随后会重启一次。`
    if (!confirm(summary)) return
    setRestoring(true)
    try {
      await window.api.backup.restore(restoreInfo.path)
      toast('恢复完成，程序正在重启…')
    } catch (e) {
      setRestoring(false)
      toast((e as Error).message, 'error')
    }
  }

  const installUpdate = async () => {
    if (
      !confirm(
        `要装上 v${update?.version ?? ''} 吗？\n\n程序会先自动备份一次当前数据，然后退出并安装，装完自己再打开。\n备份没能做成时不会安装。`
      )
    )
      return
    try {
      const r = await window.api.updater.install()
      if (!r.ok) toast(r.message ?? '安装没成功', 'error')
    } catch (e) {
      // 安装器被杀软/系统锁住时 quitAndInstall 会同步抛错，不接住就是「点了没反应」
      toast((e as Error).message || '安装没成功，请稍后重试或到设置里手动检查更新', 'error')
    }
  }

  const day = (k: string, v: string) => setS({ ...s, [k]: v === '' ? '' : Number(v) })

  return (
    <>
      <div className="topbar">
        <h1>设置</h1>
        <div className="spacer" />
        <Button variant="primary" onClick={save}>
          保存设置
        </Button>
      </div>

      <div className="content">
        <Card title="公司信息" actions={<span className="faint">打印在 PI / PL 抬头</span>}>
          <div className="field">
            <label>公司名称</label>
            <input className="w-full" value={s.company.name} onChange={(e) => setCompany('name', e.target.value)} />
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
              <input className="w-md" value={s.company.phone} onChange={(e) => setCompany('phone', e.target.value)} />
            </div>
            <div className="field">
              <label>邮箱</label>
              <input className="w-md" value={s.company.email} onChange={(e) => setCompany('email', e.target.value)} />
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
              <Button onClick={importLogo}>{s.company.logoFile ? '更换 Logo' : '导入 Logo'}</Button>
            </div>
          </div>
        </Card>

        <Card
          title="收款账户"
          actions={
            <Button size="sm" onClick={addBank}>
              + 添加账户
            </Button>
          }
        >
          {s.banks.length === 0 ? (
            <div className="hint">还没有银行账户。添加后 PI 会自动印上收款信息。</div>
          ) : (
            s.banks.map((b: any) => (
              <div key={b.uid} style={{ marginBottom: 16 }}>
                <div className="row mb">
                  <select
                    value={b.currency}
                    title="这一账户收哪种币"
                    onChange={(e) => setBank(b.uid, 'currency', e.target.value)}
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c} disabled={c !== b.currency && s.banks.some((o: any) => o.uid !== b.uid && o.currency === c)}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <div className="spacer" />
                  <Button variant="danger" size="sm" onClick={() => removeBank(b.uid)}>
                    移除
                  </Button>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>账户名</label>
                    <input
                      className="w-lg"
                      value={b.accountName}
                      onChange={(e) => setBank(b.uid, 'accountName', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>银行名称</label>
                    <input
                      className="w-lg"
                      value={b.bankName}
                      onChange={(e) => setBank(b.uid, 'bankName', e.target.value)}
                    />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>账号</label>
                    <input className="w-md" value={b.accountNo} onChange={(e) => setBank(b.uid, 'accountNo', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>SWIFT</label>
                    <input className="w-md" value={b.swift} onChange={(e) => setBank(b.uid, 'swift', e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  {/* R4-S6：银行地址会印在 PI 上给客户打款，原来 320px 把尾巴硬切了，
                        加宽到和「银行名称」同宽（w-lg 520px） */}
                  <label>银行地址</label>
                  <input className="w-lg" value={b.address} onChange={(e) => setBank(b.uid, 'address', e.target.value)} />
                </div>
              </div>
            ))
          )}
        </Card>

        <Card title="这台电脑谁在用" actions={<span className="faint">签在每一条操作历史上</span>}>
          <div className="field">
            <label>操作员名字</label>
            <input
              className="w-md"
              maxLength={40}
              value={s.operator ?? ''}
              placeholder="例如：陈培根"
              onChange={(e) => setS({ ...s, operator: e.target.value })}
            />
            <div className="hint">
              开单、改交期、收款、作废、删照片这些动作都会记下是谁做的。换人用这台电脑时改这里就行。
            </div>
          </div>
        </Card>

        <Card title="业务默认值">
          <div className="field-row-3">
            <div className="field">
              <label>PI 有效期（天）</label>
              <input type="number" min={1} max={365} value={s.piValidDays} onChange={(e) => day('piValidDays', e.target.value)} />
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
                disabled={baseLocked}
                onChange={(e) => setS({ ...s, baseCurrency: e.target.value })}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <div className="hint">
                {baseLocked
                  ? `已经有单据按 ${s.baseCurrency} 记账了，基准币锁定——换了它，历史待收、毛利、报表会集体错位且改不回来`
                  : '报表和待收都折成这一种币；开单以后就锁死，改不了'}
              </div>
            </div>
          </div>

          <div className="field-row-3">
            <div className="field">
              <label>催确认阈值（天）</label>
              <input
                type="number"
                min={0}
                max={365}
                value={s.remindConfirmDays}
                onChange={(e) => day('remindConfirmDays', e.target.value)}
              />
              <div className="hint">PI 发出超过该天数未确认则提醒</div>
            </div>
            <div className="field">
              <label>催款阈值（天）</label>
              <input
                type="number"
                min={0}
                max={365}
                value={s.remindPaymentDays}
                onChange={(e) => day('remindPaymentDays', e.target.value)}
              />
              <div className="hint">客户确认后超过该天数未收款则提醒</div>
            </div>
            <div className="field">
              <label>催尾款阈值（天）</label>
              <input
                type="number"
                min={0}
                max={365}
                value={s.remindBalanceDays}
                onChange={(e) => day('remindBalanceDays', e.target.value)}
              />
              <div className="hint">已收定金但未收齐，超过该天数提醒催尾款</div>
            </div>
          </div>

          <div className="field-row-3">
            <div className="field">
              <label>出货提醒提前（天）</label>
              <input
                type="number"
                min={0}
                max={90}
                value={s.remindShipDays}
                onChange={(e) => day('remindShipDays', e.target.value)}
              />
              <div className="hint">距预计出货日该天数时提醒备货</div>
            </div>
            <div className="field">
              <label>毛重系数</label>
              <input
                type="number"
                step="0.01"
                min={1}
                max={3}
                value={s.grossWeightFactor}
                onChange={(e) => setS({ ...s, grossWeightFactor: Number(e.target.value) })}
              />
              <div className="hint">
                装箱单没填毛重时按此系数估算。改动只影响今后新填的箱子，已经出运的单据上标的还是当年的结论
              </div>
            </div>
          </div>
        </Card>

        {sourceCard}

        <Card title="数据备份">
          <div className="hint" style={{ marginBottom: 6 }}>
            主数据库：<span className="mono">{paths?.db ?? '…'}</span>
          </div>
          <div className="hint" style={{ marginBottom: 6 }}>
            图片目录：<span className="mono">{paths?.images ?? '…'}</span>
          </div>
          <div className="hint" style={{ marginBottom: 6 }}>
            单据存档：<span className="mono">{paths?.docs ?? '…'}</span>
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>
            备份目录：<span className="mono">{paths?.backups ?? '…'}</span>
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>
            程序每天启动时自动备份一次，保留最近 30 份。备份把数据库、商品图片、单据存档 PDF 一起打包，缺一样都不算备齐。
          </div>
          <div className="hint" style={{ marginBottom: 12 }}>
            最近一次成功备份：<strong>{sinceWords(s.lastBackupAt)}</strong>
          </div>
          {s.lastBackupError ? (
            <div className="alert warn" style={{ marginBottom: 12 }}>
              上一次备份没成功：{s.lastBackupError}
            </div>
          ) : null}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Button variant="primary" disabled={busy} onClick={runBackup}>
              {busy ? '备份中，别关窗口…' : '立即备份'}
            </Button>
            <Button
              onClick={async () => {
                const d = await window.api.backup.reveal()
                if (d) setLastBackupFile(d)
              }}
            >
              打开备份目录
            </Button>
            <Button disabled={restoring} onClick={chooseRestoreFile}>
              从备份恢复…
            </Button>
          </div>
          {lastBackupFile ? <div className="hint mono" style={{ marginTop: 8 }}>{lastBackupFile}</div> : null}

          {restoreInfo ? (
            <div className="alert info" style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 6 }}>
                <strong>准备用这一份恢复</strong>
              </div>
              <div className="hint mono" style={{ marginBottom: 6, wordBreak: 'break-all' }}>
                {restorePath}
              </div>
              <div className="hint" style={{ marginBottom: 8 }}>
                备份于 {restoreInfo.takenAt ? new Date(restoreInfo.takenAt).toLocaleString() : '时间未知'} · 订单{' '}
                {restoreInfo.orderCount ?? '—'} 张 · 收款 {restoreInfo.paymentCount ?? '—'} 笔 · {restoreInfo.entryCount}{' '}
                个文件 · {(restoreInfo.fileSize / MB).toFixed(1)} MB
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Button variant="danger" disabled={restoring} onClick={doRestore}>
                  {restoring ? '恢复中，程序马上重启…' : '替换成这一份'}
                </Button>
                <Button
                  disabled={restoring}
                  onClick={() => {
                    setRestoreInfo(null)
                    setRestorePath('')
                  }}
                >
                  取消
                </Button>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                替换之前会先把现在的数据压一份留成 pre-restore 备份，选错了还能退回来。
              </div>
            </div>
          ) : null}
        </Card>

        <Card title="软件更新">
          <div className="field-row">
            <div className="field">
              <label>当前版本</label>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <span className="mono" style={{ fontSize: 16 }}>
                  {update?.currentVersion ?? '—'}
                </span>
                <Button
                  disabled={update?.status === 'checking' || update?.status === 'downloading'}
                  onClick={async () => {
                    try {
                      setUpdate(await window.api.updater.check())
                    } catch (e) {
                      toast((e as Error).message, 'error')
                    }
                  }}
                >
                  检查更新
                </Button>
                {update?.status === 'available' ? (
                  <Button
                    variant="primary"
                    onClick={async () => {
                      try {
                        setUpdate(await window.api.updater.download())
                      } catch (e) {
                        toast((e as Error).message, 'error')
                      }
                    }}
                  >
                    下载 v{update.version}
                  </Button>
                ) : null}
                {update?.status === 'downloaded' ? (
                  <Button variant="primary" onClick={installUpdate}>
                    重启安装 v{update.version}
                  </Button>
                ) : null}
              </div>
              <div className="hint">
                有新版时会显示下载按钮，下载完点「重启安装」，程序会先备份一次再自己关了自己装完。
              </div>
            </div>
          </div>

          {/* 状态反馈 */}
          {update?.status === 'checking' ? <div className="alert info">正在检查更新…</div> : null}
          {update?.status === 'not-available' ? (
            <div className="alert info">已经是最新版本（v{update.version ?? update.currentVersion}）。</div>
          ) : null}
          {update?.status === 'available' ? (
            <div className="alert warn">
              发现新版本 <strong>v{update.version}</strong>
              {update.releaseDate ? (
                <span className="faint">（{String(update.releaseDate).slice(0, 10)}）</span>
              ) : null}
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
                正在下载 v{update.version ?? ''}… <strong>{update.percent ?? 0}%</strong>
                {update.transferred != null && update.total != null ? (
                  <span className="faint">
                    {' '}
                    （{Math.round(update.transferred / MB)}MB / {Math.round(update.total / MB)}MB）
                  </span>
                ) : null}
              </div>
              <div style={{ height: 6, background: '#e2e6ee', borderRadius: 3, overflow: 'hidden' }}>
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
            <div className="alert info">已下载完成，点上面「重启安装 v{update.version}」即可。</div>
          ) : null}
          {update?.status === 'error' ? <div className="alert warn">{update.message ?? '出错了'}</div> : null}

          <div className="hint" style={{ marginTop: 10 }}>
            更新来自 GitHub Releases，需要能访问 github.com。如果下载慢，
            <Button
              size="sm"
              style={{ marginLeft: 6 }}
              onClick={() => void window.api.shell.openExternal('https://github.com/chenpeigen2/IKanBot/releases')}
            >
              去 GitHub 手动下载
            </Button>
          </div>
        </Card>
      </div>
    </>
  )
}
