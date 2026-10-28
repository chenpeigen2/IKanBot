/**
 * 存档前的那道问句：屏幕上这张纸，还是现在这些数据算出来的那张纸吗？
 *
 * 预览是可以一直开着的。纸面渲染完以后，底下这张单还能被改动（同页别的弹窗、
 * 别的窗口，甚至上一笔存档自己就把批次金额钉住了）。版次号只对得上「存过几版」，
 * 对不上内容——旧纸照样会被存成正式的一版，事后查档，PDF 和系统里的账各说各话，
 * 而「出过 CI 锁单价」「有存档禁删」这些闸门全部按那份错账放行。
 *
 * 所以存档前把喂给纸面的那几份数据（订单或报价 + 设置）各算一次指纹：
 * 渲染层用预览当时手里的那份，主进程用库里现在这份，对不上就拒存，让人重开预览。
 * 图片不在指纹里：换一张主图不改纸上的数字，为它拒一次存档不值当。
 */
import type { DocKind } from './types'

/** 键序稳定、数值走 JSON 的最短往返表示；渲染层和主进程必须算出同一个串 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

export interface DocPageInputs {
  kind: DocKind
  docNo: string
  /** 订单详情（orders:get 那份原样）：pi / pl / ci 用 */
  order?: unknown
  /** 报价详情（quotations:get 那份原样）：quotation 用 */
  quotation?: unknown
  /** 设置（settings:get 那份原样）：抬头、收款账户、条款都印在纸上 */
  settings?: unknown
}

/** 纸面数据指纹：同一种号，两个进程各算一次，对不上就说明纸已经不是这张纸 */
export function docPageFingerprint(input: DocPageInputs): string {
  const raw = stableStringify({
    kind: input.kind,
    docNo: input.docNo,
    order: input.order ?? null,
    quotation: input.quotation ?? null,
    settings: input.settings ?? null
  })
  return `${fnv1a(raw)}${djb2(raw)}`
}

/** 拒存时的话术：一句话说清「为什么要重开预览」，别让人以为存档坏了 */
export function stalePageMessage(docNo: string, kind: DocKind): string {
  return (
    `${String(kind).toUpperCase()} ${docNo} 这一版纸面已经过时了：预览打开以后，这张单的数据又变过` +
    '（也可能是刚刚存过一版，批次金额已被那份纸面钉住）。\n' +
    '存进去的就是这张旧纸——PDF 和系统里的账会对不上，而且以后查档只认这一版。\n' +
    '请关掉预览、重新打开，按现在的数据再存一次。'
  )
}
