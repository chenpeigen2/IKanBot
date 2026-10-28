/**
 * 明细行的入口闸门：数量与单价。
 *
 * 闸门写在服务层而不是界面里，因为 IPC 是任何调用方都能打的——界面少一个校验，
 * 库里就多一条负数行。一旦进来负数或半件：累计已装量被压低（超装反而放行）、
 * 整单金额/应收/毛利跟着错、纸面单据把负数件印给海关和客户。
 *
 * 话术一律用 bizError：后端只把这个类型当「给用户看的话」，其它错误按 500 藏起来。
 */
import { bizError } from './errors'

/** 数量：必须是有限正整数（服装按件算，半件在箱单和报关上都说不清） */
export function assertQuantity(qty: unknown, label = '数量', hint = ''): void {
  const n = Number(qty)
  if (!Number.isFinite(n)) {
    throw bizError(`${label}「${String(qty)}」不是数字，请填 1 以上的整数件数`)
  }
  if (!Number.isInteger(n)) {
    throw bizError(`${label} ${n} 不是整件——半件没法装箱，也没法报关`)
  }
  if (n <= 0) {
    throw bizError(
      `${label}必须是 1 件以上。填 0 或负数会把整单件数、已装量和应收一起算错${hint ? `；${hint}` : ''}`
    )
  }
}

/**
 * 单价：必须是有限的非负数。
 * allowZero=false（卖货的行）时 0 也算没填——按 0 报价会把整单金额和毛利静默做成 0；
 * 打样行允许 0（免费样是真实业务）。
 */
export function assertUnitPrice(price: unknown, label = '单价', allowZero = false): void {
  const n = Number(price)
  if (!Number.isFinite(n)) {
    throw bizError(`${label}「${String(price)}」不是数字，请填一个金额（不填价格会算错整单）`)
  }
  if (n < 0) {
    throw bizError(`${label}不能是负数（${n}）——负单价会把整单金额、应收和毛利全部算反`)
  }
  if (!allowZero && n === 0) {
    throw bizError(`${label}还没填，按 0 保存会让这张单的金额、应收和毛利全变成 0；确实免费请走样品单`)
  }
}

/** 成本/费用类金额：允许留空（未知），给了就必须是非负的真实数字 */
export function assertOptionalMoney(v: unknown, label: string): void {
  if (v == null || v === '') return
  const n = Number(v)
  if (!Number.isFinite(n)) throw bizError(`${label}「${String(v)}」不是数字，请填金额或留空`)
  if (n < 0) throw bizError(`${label}不能是负数（${n}）`)
}

/**
 * 定金比例只许落在 0–1（0.3 = 30%）：界面下拉给不出别的值，但 IPC/导入能塞进 1.5。
 * 超出范围 PI 会印出「定金大于合计、尾款是负数」，客户照着一张负余额的纸付款。
 */
export function assertDepositRatio(v: unknown): void {
  if (v == null) return
  const r = Number(v)
  if (!Number.isFinite(r) || r < 0 || r > 1) {
    throw bizError(
      `定金比例要填 0 到 1 之间的数（0.3 = 30%），收到的是「${String(v)}」。` +
        `超出范围的 PI 会印出定金大于合计、尾款是负数，客户按它付款就乱了。`
    )
  }
}

/**
 * 单号（PI 号 / 单据号）会直接当存档目录名用：只允许安全字符，杜绝 ../ 和 Windows 保留字符。
 * 存档那一步必须拦，但等到出单才拦就太晚了——单已经发给客户，纸面上的号却打不开存档目录。
 */
const SAFE_DOC_NO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export function assertDocNo(docNo: unknown, label = '单据号'): string {
  const v = String(docNo ?? '').trim()
  if (!SAFE_DOC_NO.test(v)) {
    throw bizError(
      `${label}「${v || '(空)'}」不能用来建存档目录：只能用字母、数字、点、下划线、短横线，且不能以符号开头。请先把单号改成正常编号。`
    )
  }
  return v
}
