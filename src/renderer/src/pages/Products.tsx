import { useEffect, useState } from 'react'
import { Modal, useToast, money, Empty } from '../ui'
import { imageUrl } from '../imageUrl'
import type { Product, ProductImage } from '../../../shared/types'

interface Draft {
  id?: number
  styleNo: string
  name: string
  composition: string
  category: string
  brand: string
  season: string
  costPrice: string
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

  const load = async (kw = keyword) => {
    const rows = await window.api.products.list(kw)
    setList(rows)
  }

  useEffect(() => {
    void load('')
  }, [])

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
    if (!confirm(`确认删除商品「${p.styleNo}」？历史订单中的行不受影响。`)) return
    try {
      await window.api.products.remove(p.id)
      toast('已删除')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const copyProduct = async (p: Product) => {
    const no = prompt(`复制款号「${p.styleNo}」，请输入新款号：`, `${p.styleNo}-COPY`)
    if (!no) return
    try {
      await window.api.products.copy(p.id, no.trim())
      toast('已复制，可编辑后保存')
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const pickImages = async () => {
    if (!draft?.id) {
      toast('请先保存商品，再上传图片', 'error')
      return
    }
    const files = await window.api.images.pick()
    for (const f of files) {
      const isFirst = images.length === 0
      await window.api.products.addImage(draft.id, f, isFirst)
    }
    setImages(await window.api.products.images(draft.id))
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
        <button className="btn primary" onClick={openNew}>
          + 新增商品
        </button>
      </div>

      <div className="content">
        <div className="toolbar">
          <input
            className="search"
            placeholder="搜索款号 / 品名 / 成分"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <button className="btn" onClick={() => load()}>
            搜索
          </button>
          <div className="spacer" />
          <span className="faint">共 {list.length} 个款号</span>
        </div>

        <div className="card">
          <div className="card-body tight">
            {list.length === 0 ? (
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
                      <th className="num">成本价</th>
                      <th>备注</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id} className="clickable" onClick={() => openEdit(p)}>
                        <td className="mono nowrap">{p.styleNo}</td>
                        <td>{p.name}</td>
                        <td className="muted">{p.composition}</td>
                        <td className="muted nowrap">{p.sizes.join(' / ') || '—'}</td>
                        <td className="muted">{p.colors.join(', ') || '—'}</td>
                        <td className="num">{p.costPrice == null ? '—' : money(p.costPrice)}</td>
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
              <button className="btn" onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="btn primary" onClick={save}>
                保存
              </button>
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
              <label>成本价（工厂价，可空）</label>
              <input
                type="number"
                step="0.01"
                value={draft.costPrice}
                onChange={(e) => setDraft({ ...draft, costPrice: e.target.value })}
                placeholder="不填则不核算毛利"
              />
            </div>
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
                <button
                  className="btn"
                  onClick={() => {
                    addTag('sizes', sizeInput)
                    setSizeInput('')
                  }}
                >
                  添加
                </button>
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
                <button
                  className="btn"
                  onClick={() => {
                    addTag('colors', colorInput)
                    setColorInput('')
                  }}
                >
                  添加
                </button>
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
                          await window.api.products.setPrimary(draft.id, im.id)
                          setImages(await window.api.products.images(draft.id))
                        }}
                      >
                        设主图
                      </button>
                    ) : null}
                    <button
                      onClick={async () => {
                        await window.api.products.delImage(im.id)
                        if (draft?.id) setImages(await window.api.products.images(draft.id))
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
    </>
  )
}
