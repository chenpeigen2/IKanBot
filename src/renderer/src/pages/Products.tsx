import { useEffect, useState } from 'react'
import { Modal, useToast, money, Empty, Button, LoadError, PromptModal } from '../ui'
import { imageUrl } from '../imageUrl'
import type { Product, ProductImage } from '../../../shared/types'
import { CSV_BOM, looksGarbled, pickCsvDecode } from '../../../shared/csv'

interface Draft {
  id?: number
  styleNo: string
  name: string
  composition: string
  category: string
  brand: string
  season: string
  costPrice: string
  factory: string
  factoryNo: string
  unitNetWeight: string
  boxPieces: string
  boxLength: string
  boxWidth: string
  boxHeight: string
  note: string
  sizes: string[]
  colors: string[]
}

function emptyDraft(): Draft {
  return {
    styleNo: '',
    name: '',
    composition: '',
    category: '',
    brand: '',
    season: '',
    costPrice: '',
    factory: '',
    factoryNo: '',
    unitNetWeight: '',
    boxPieces: '',
    boxLength: '',
    boxWidth: '',
    boxHeight: '',
    note: '',
    sizes: [],
    colors: []
  }
}

export default function Products() {
  const toast = useToast()
  const [list, setList] = useState<Product[]>([])
  const [keyword, setKeyword] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [images, setImages] = useState<ProductImage[]>([])
  const [sizeInput, setSizeInput] = useState('')
  const [colorInput, setColorInput] = useState('')
  // R5：成本是工厂价，得记下来自哪家工厂；停用不等于删除（历史单据还要重印）
  const [includeInactive, setIncludeInactive] = useState(false)
  const [baseCurrency, setBaseCurrency] = useState('CNY')
  const [showImport, setShowImport] = useState(false)
  const [copyFrom, setCopyFrom] = useState<Product | null>(null)
  /** 读取失败不能装成「还没有商品」 */
  const [loadError, setLoadError] = useState('')

  const load = async (kw = keyword) => {
    try {
      const rows = await window.api.products.list(kw, includeInactive)
      setList(rows)
      setLoadError('')
    } catch (e) {
      setLoadError((e as Error).message || '商品列表没加载出来')
    }
  }

  useEffect(() => {
    void window.api.settings.get().then((s) => setBaseCurrency(s.baseCurrency || 'CNY'))
  }, [])

  // 首次进入和「显示已停用」切换都走这里
  useEffect(() => {
    void load()
  }, [includeInactive])

  const openEdit = async (p: Product) => {
    setDraft({
      id: p.id,
      styleNo: p.styleNo,
      name: p.name,
      composition: p.composition,
      category: p.category,
      brand: p.brand,
      season: p.season,
      costPrice: p.costPrice == null ? '' : String(p.costPrice),
      factory: p.factory ?? '',
      factoryNo: p.factoryNo ?? '',
      unitNetWeight: p.unitNetWeight == null ? '' : String(p.unitNetWeight),
      boxPieces: p.boxPieces == null ? '' : String(p.boxPieces),
      boxLength: p.boxLength == null ? '' : String(p.boxLength),
      boxWidth: p.boxWidth == null ? '' : String(p.boxWidth),
      boxHeight: p.boxHeight == null ? '' : String(p.boxHeight),
      note: p.note,
      sizes: [...p.sizes],
      colors: [...p.colors]
    })
    setImages(await window.api.products.images(p.id))
  }

  const openNew = () => {
    setDraft(emptyDraft())
    setImages([])
  }

  const save = async () => {
    if (!draft) return
    if (!draft.styleNo.trim()) {
      toast('请填写款号', 'error')
      return
    }
    try {
      await window.api.products.save({
        id: draft.id,
        styleNo: draft.styleNo.trim(),
        name: draft.name,
        composition: draft.composition,
        category: draft.category,
        brand: draft.brand,
        season: draft.season,
        costPrice: draft.costPrice.trim() === '' ? null : Number(draft.costPrice),
        factory: draft.factory,
        factoryNo: draft.factoryNo,
        unitNetWeight: draft.unitNetWeight.trim() === '' ? null : Number(draft.unitNetWeight),
        boxPieces: draft.boxPieces.trim() === '' ? null : Number(draft.boxPieces),
        boxLength: draft.boxLength.trim() === '' ? null : Number(draft.boxLength),
        boxWidth: draft.boxWidth.trim() === '' ? null : Number(draft.boxWidth),
        boxHeight: draft.boxHeight.trim() === '' ? null : Number(draft.boxHeight),
        sizes: draft.sizes,
        colors: draft.colors,
        note: draft.note
      })
      toast(draft.id ? '已保存' : '已新增商品')
      setDraft(null)
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const remove = async (p: Product) => {
    if (!confirm(`确认删除商品「${p.styleNo}」？被订单用过的款不会真删，只会被停用。`)) return
    try {
      const res = await window.api.products.remove(p.id)
      toast(res.message || (res.deactivated ? '已停用' : '已删除'))
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const toggleActive = async (p: Product) => {
    try {
      await window.api.products.setActive(p.id, p.active ? 0 : 1)
      toast(p.active ? '已停用：不再出现在选款列表，历史单据照旧' : '已重新启用')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const copyProduct = async (p: Product) => {
    setCopyFrom(p)
  }

  const doCopy = async (no: string) => {
    if (!copyFrom) return false
    if (!no) {
      toast('新款号不能为空', 'error')
      return false
    }
    try {
      await window.api.products.copy(copyFrom.id, no)
      toast('已复制，可编辑后保存')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
      return false
    }
  }

  const pickImages = async () => {
    if (!draft?.id) {
      toast('请先保存商品，再上传图片', 'error')
      return
    }
    let files: string[] = []
    try {
      files = await window.api.images.pick()
    } catch (e) {
      toast((e as Error).message || '打开文件选择器失败', 'error')
      return
    }
    const isFirst = images.length === 0
    let ok = 0
    const failed: string[] = []
    for (const f of files) {
      try {
        await window.api.products.addImage(draft.id, f, isFirst)
        ok++
      } catch {
        failed.push(f)
      }
    }
    // 中途失败的那几张已经拷进图片目录但没登记进库，不清就永远背在备份里
    if (failed.length) {
      try {
        await window.api.images.discard(failed)
      } catch {
        /* 清不掉不挡主流程 */
      }
      toast(ok ? `已上传 ${ok} 张，${failed.length} 张失败，请重试` : '上传图片失败', ok ? undefined : 'error')
    }
    if (ok) {
      try {
        setImages(await window.api.products.images(draft.id))
      } catch (e) {
        toast((e as Error).message || '图片列表刷新失败', 'error')
      }
    }
  }

  const addTag = (which: 'sizes' | 'colors', value: string) => {
    const v = value.trim()
    if (!v || !draft) return
    if (draft[which].includes(v)) return
    setDraft({ ...draft, [which]: [...draft[which], v] })
  }

  return (
    <>
      <div className="topbar">
        <h1>商品库</h1>
        <div className="spacer" />
        <Button  onClick={() => setShowImport(true)}>
          批量导入
        </Button>
        <Button variant="primary"  onClick={openNew}>
          + 新增商品
        </Button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索款号 / 品名 / 成分 / 工厂"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <Button  onClick={() => load()}>
            搜索
          </Button>
          <div className="spacer" />
          <div className="field" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              id="show-inactive"
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
            />
            <label htmlFor="show-inactive" style={{ marginBottom: 0 }}>
              显示已停用
            </label>
          </div>
          <span className="faint">共 {list.length} 个款号</span>
        </div>

        <div className="card">
          <div className="card-body tight">
            {loadError ? (
              <LoadError what="商品列表" message={loadError} onRetry={() => void load()} />
            ) : list.length === 0 ? (
              <Empty text="还没有商品，点右上角「新增商品」开始录入" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>款号</th>
                      <th>品名</th>
                      <th>成分</th>
                      <th>尺码</th>
                      <th>颜色</th>
                      <th>工厂</th>
                      <th className="num">成本价</th>
                      <th>备注</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr
                        key={p.id}
                        className="clickable"
                        style={p.active ? undefined : { opacity: 0.5 }}
                        onClick={() => openEdit(p)}
                      >
                        <td className="mono nowrap">
                          {p.styleNo}
                          {!p.active ? <span className="tag" style={{ marginLeft: 6 }}>已停用</span> : null}
                        </td>
                        <td>{p.name}</td>
                        <td className="muted">{p.composition}</td>
                        <td className="muted nowrap">{p.sizes.join(' / ') || '—'}</td>
                        <td className="muted">{p.colors.join(', ') || '—'}</td>
                        <td className="muted">{p.factory || '—'}</td>
                        <td className="num" title={`工厂价（${baseCurrency}），下单时按订单汇率折算`}>
                          {p.costPrice == null ? '—' : money(p.costPrice)}
                        </td>
                        {/* R4-P6：备注为空时显示辅助灰的「—」，
                            否则整列全空会让人以为“备注没显示出来”。 */}
                        <td className="faint cell-clip" title={p.note || undefined}>
                          {p.note || '—'}
                        </td>
                        <td className="cell-actions">
                          <button
                            className="link"
                            onClick={(e) => {
                              e.stopPropagation()
                              copyProduct(p)
                            }}
                          >
                            复制
                          </button>
                          <button
                            className="link"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleActive(p)
                            }}
                          >
                            {p.active ? '停用' : '启用'}
                          </button>
                          <button
                            className="link danger"
                            onClick={(e) => {
                              e.stopPropagation()
                              remove(p)
                            }}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {draft ? (
        <Modal
          title={draft.id ? `编辑商品 ${draft.styleNo}` : '新增商品'}
          onClose={() => setDraft(null)}
          size="wide"
          footer={
            <>
              <Button  onClick={() => setDraft(null)}>
                取消
              </Button>
              <Button variant="primary"  onClick={save}>
                保存
              </Button>
            </>
          }
        >
          <div className="field-row">
            <div className="field">
              {/* R4-S4：应用内表单 label 一律中文；中英双语只出现在要发给客户的单据上 */}
              <label>款号 *</label>
              <input
                value={draft.styleNo}
                onChange={(e) => setDraft({ ...draft, styleNo: e.target.value })}
                placeholder="如 A001"
              />
            </div>
            <div className="field">
              <label>品名</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="如 纯棉圆领T恤"
              />
            </div>
          </div>

          <div className="field">
            <label>成分</label>
            <input
              value={draft.composition}
              onChange={(e) => setDraft({ ...draft, composition: e.target.value })}
              placeholder="如 100% Cotton / 纯棉"
            />
          </div>

          <div className="field-row-3">
            <div className="field">
              <label>单件净重（kg，可空）</label>
              <input
                type="number"
                step="0.001"
                value={draft.unitNetWeight}
                onChange={(e) => setDraft({ ...draft, unitNetWeight: e.target.value })}
                placeholder="装箱单自动算净重用"
              />
            </div>
            <div className="field">
              <label>每箱件数（可空）</label>
              <input
                type="number"
                value={draft.boxPieces}
                onChange={(e) => setDraft({ ...draft, boxPieces: e.target.value })}
                placeholder="如 40"
              />
            </div>
            <div className="field">
              <label>箱规（长×宽×高 cm，可空）</label>
              <div className="row" style={{ gap: 4 }}>
                <input
                  type="number"
                  placeholder="长"
                  value={draft.boxLength}
                  onChange={(e) => setDraft({ ...draft, boxLength: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="宽"
                  value={draft.boxWidth}
                  onChange={(e) => setDraft({ ...draft, boxWidth: e.target.value })}
                />
                <input
                  type="number"
                  placeholder="高"
                  value={draft.boxHeight}
                  onChange={(e) => setDraft({ ...draft, boxHeight: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="field-row-3">
            <div className="field">
              <label>工厂成本价（{baseCurrency}，可空）</label>
              <input
                type="number"
                step="0.01"
                value={draft.costPrice}
                onChange={(e) => setDraft({ ...draft, costPrice: e.target.value })}
                placeholder="不填则不核算毛利"
              />
              <div className="hint">记工厂开给你的价（基准币）；下单时系统按订单汇率折成本单币种，不用自己换算。</div>
            </div>
            <div className="field">
              <label>工厂</label>
              <input
                value={draft.factory}
                onChange={(e) => setDraft({ ...draft, factory: e.target.value })}
                placeholder="哪家做的，如 汕头华鑫"
              />
            </div>
            <div className="field">
              <label>工厂货号</label>
              <input
                value={draft.factoryNo}
                onChange={(e) => setDraft({ ...draft, factoryNo: e.target.value })}
                placeholder="工厂那边的号，返单时用"
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>类目</label>
              <input
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                placeholder="如 T恤"
              />
            </div>
            <div className="field">
              <label>品牌 / 季节</label>
              <div className="row">
                <input
                  value={draft.brand}
                  onChange={(e) => setDraft({ ...draft, brand: e.target.value })}
                  placeholder="品牌"
                />
                <input
                  value={draft.season}
                  onChange={(e) => setDraft({ ...draft, season: e.target.value })}
                  placeholder="SS26"
                />
              </div>
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label>尺码表（本款号自有，可任意填写）</label>
              <div className="row">
                <input
                  value={sizeInput}
                  placeholder="输入尺码后回车，如 S / 40 / XXL"
                  onChange={(e) => setSizeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag('sizes', sizeInput)
                      setSizeInput('')
                    }
                  }}
                />
                <Button
                  
                  onClick={() => {
                    addTag('sizes', sizeInput)
                    setSizeInput('')
                  }}
                >
                  添加
                </Button>
              </div>
              <div className="chip-list">
                {draft.sizes.map((s) => (
                  <span key={s} className="chip">
                    {s}
                    <button onClick={() => setDraft({ ...draft, sizes: draft.sizes.filter((x) => x !== s) })}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="field">
              <label>颜色表（本款号自有）</label>
              <div className="row">
                <input
                  value={colorInput}
                  placeholder="输入颜色后回车，如 Black"
                  onChange={(e) => setColorInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag('colors', colorInput)
                      setColorInput('')
                    }
                  }}
                />
                <Button
                  
                  onClick={() => {
                    addTag('colors', colorInput)
                    setColorInput('')
                  }}
                >
                  添加
                </Button>
              </div>
              <div className="chip-list">
                {draft.colors.map((c) => (
                  <span key={c} className="chip">
                    {c}
                    <button onClick={() => setDraft({ ...draft, colors: draft.colors.filter((x) => x !== c) })}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <label>备注</label>
            <textarea
              rows={2}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="本款特殊要求，如 logo 位置在左胸"
            />
          </div>

          <div className="field">
            <label>商品图片（PI 会显示主图）</label>
            <div className="img-grid">
              {images.map((im) => (
                <div key={im.id} className={`img-thumb ${im.isPrimary ? 'primary' : ''}`}>
                  <img src={imageUrl(im.fileName)} alt="" />
                  {im.isPrimary ? <span className="primary-mark">主图</span> : null}
                  <div className="thumb-bar">
                    {!im.isPrimary ? (
                      <button
                        onClick={async () => {
                          if (!draft?.id) return
                          try {
                            await window.api.products.setPrimary(draft.id, im.id)
                            setImages(await window.api.products.images(draft.id))
                          } catch (e) {
                            toast((e as Error).message || '设主图失败', 'error')
                          }
                        }}
                      >
                        设主图
                      </button>
                    ) : null}
                    <button
                      onClick={async () => {
                        try {
                          await window.api.products.delImage(im.id)
                          if (draft?.id) setImages(await window.api.products.images(draft.id))
                        } catch (e) {
                          toast((e as Error).message || '删除图片失败', 'error')
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
              <button className="img-thumb" onClick={pickImages} style={{ cursor: 'pointer' }}>
                <span style={{ fontSize: 20, color: 'var(--text-faint)' }}>+</span>
              </button>
            </div>
            {!draft.id ? (
              <div className="hint">保存商品后即可上传图片</div>
            ) : (
              <div className="hint">第一张上传的图会自动设为主图</div>
            )}
          </div>
        </Modal>
      ) : null}

      {showImport ? (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={async () => {
            setShowImport(false)
            await load()
          }}
        />
      ) : null}

      {copyFrom ? (
        <PromptModal
          title={`复制款号「${copyFrom.styleNo}」`}
          label="请输入新款号："
          initial={`${copyFrom.styleNo}-COPY`}
          okText="复制"
          onOk={(no) => doCopy(no)}
          onClose={() => setCopyFrom(null)}
        />
      ) : null}
    </>
  )
}

/** CSV 批量导入：贴文本或选文件都认，表头中英文都行 */
function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'skip' | 'overwrite'>('skip')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(
    null
  )

  const downloadTemplate = async () => {
    const header = await window.api.products.csvTemplate()
    // BOM 不能省：中文 Windows 的 Excel 双击打开没有 BOM 的 UTF-8 文件会按 GBK 解，
    // 表头直接变乱码，用户以为模板坏了
    const blob = new Blob([`${CSV_BOM}${header}\n`], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '商品库导入模板.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const pickFile = () =>
    new Promise<void>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.csv,text/csv,text/plain'
      input.onchange = () => {
        const f = input.files?.[0]
        if (!f) return resolve()
        void readFile(f).finally(() => resolve())
      }
      input.click()
    })

  /** 先按 UTF-8 读；读出乱码再按 GBK 读一遍（Excel「另存为 CSV」在中文 Windows 默认就是 GBK） */
  const readFile = async (f: File) => {
    let utf8: string
    try {
      utf8 = await readAsText(f, 'utf-8')
    } catch (e) {
      toast((e as Error).message, 'error')
      return
    }
    // GBK 这一遍只是补救，读不动就留着 UTF-8 那份，让导入报错讲清读到的是什么表头
    const chosen = looksGarbled(utf8)
      ? pickCsvDecode([
          { encoding: 'utf-8', text: utf8 },
          { encoding: 'gbk', text: await readAsText(f, 'gbk').catch(() => '') }
        ])
      : { encoding: 'utf-8' as const, text: utf8 }
    if (!chosen) {
      toast(`「${f.name}」是空文件，没有内容可导入`, 'error')
      return
    }
    setText(chosen.text)
    if (chosen.encoding === 'gbk') {
      toast('这份 CSV 是 GBK（ANSI）存的，已自动按 GBK 读出来；下次用「另存为 → CSV UTF-8」更稳')
    }
  }

  const readAsText = (f: File, encoding: 'utf-8' | 'gbk') =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      // 以前 onerror 直接 resolve()：读失败页面毫无反应，用户以为没点上按钮，又点一次
      reader.onerror = () =>
        reject(new Error(`「${f.name}」没读出来：文件可能正被 Excel 占用或已被移动，关掉 Excel 再试，或者把内容直接贴进来`))
      reader.readAsText(f, encoding)
    })

  const run = async () => {
    if (!text.trim()) {
      toast('先贴入 CSV 内容或选择一个文件', 'error')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.products.importCsv(text, mode)
      setResult(res)
      toast(`新增 ${res.created} 款，更新 ${res.updated} 款`)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="批量导入商品"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <Button onClick={downloadTemplate}>下载模板</Button>
          <Button onClick={() => void pickFile()}>选择 CSV 文件</Button>
          <Button variant="primary" onClick={run} disabled={busy}>
            开始导入
          </Button>
        </>
      }
    >
      <div className="hint">
        表头认中文也认英文（款号、品名、成分、尺码、颜色、成本价、工厂、工厂货号、每箱件数、箱规、单件净重、类目、品牌、季节、备注）。
        尺码/颜色用「、」或「,」分开。款号已经存在的默认跳过，选「覆盖」才会改档案。
        文件用 UTF-8 或 GBK 存的都能读（GBK 会自动识别），也可以直接把内容贴进下面的框。
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>CSV 内容</label>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="款号,品名,成分,成本价&#10;A001,纯棉圆领T恤,100% Cotton,30" />
      </div>
      <div className="field">
        <label>款号已存在时</label>
        <div className="row" style={{ gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" name="csv-mode" checked={mode === 'skip'} onChange={() => setMode('skip')} />
            跳过（只补新的）
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="radio"
              name="csv-mode"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
            />
            覆盖（按 CSV 改档案）
          </label>
        </div>
      </div>
      {result ? (
        <div className="card">
          <div className="card-body tight">
            <div>
              新增 <b>{result.created}</b> · 更新 <b>{result.updated}</b> · 跳过 <b>{result.skipped}</b>
              {result.errors.length ? ` · 有问题 ${result.errors.length} 行` : ''}
            </div>
            {result.errors.length ? (
              <ul className="hint" style={{ marginTop: 6, paddingLeft: 18 }}>
                {result.errors.slice(0, 20).map((er, i) => (
                  <li key={i}>{er}</li>
                ))}
                {result.errors.length > 20 ? <li>……其余 {result.errors.length - 20} 行略</li> : null}
              </ul>
            ) : null}
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => void onDone()}>完成</Button>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
