/**
 * 表单草稿的本地暂存（R61）。
 *
 * 场景：远端模式录单到一半 token 过期（后端换了秘钥、服务器重启），保存被 401 拦下。
 * 在这之前表单内容只活在内存里，弹窗一关、程序一重启就全没了。
 * 现在每次改动都暂存一份到本机（localStorage），保存成功才清掉；
 * 重新登录后重新打开表单，草稿自动续上。
 *
 * 存储接口对齐 localStorage（getItem/setItem/removeItem），
 * 渲染进程直接传 window.localStorage，测试传内存桩——逻辑本身不碰浏览器。
 */

export interface DraftStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 新建订单表单的草稿键（v1：字段结构变了就换版本号，老草稿自然作废） */
export const DRAFT_ORDER_NEW = 'ikan.draft.order-new.v1'

export interface DraftRecord<T> {
  /** 暂存时刻（ISO 字符串），恢复时给人看「是什么时候存的」 */
  savedAt: string
  value: T
}

function payloadOf<T>(value: T): string {
  return JSON.stringify({ savedAt: new Date().toISOString(), value })
}

function parsePayload<T>(raw: string): DraftRecord<T> | null {
  try {
    const d = JSON.parse(raw) as { savedAt?: unknown; value?: unknown }
    if (typeof d.savedAt !== 'string' || !d.value || typeof d.value !== 'object') return null
    return { savedAt: d.savedAt, value: d.value as T }
  } catch {
    // 半截 JSON（写到一半断电/进程被杀）= 没存成，当没有这份草稿
    return null
  }
}

/** 暂存一份草稿（覆盖同名旧稿） */
export function saveDraft<T>(store: DraftStore, key: string, value: T): void {
  store.setItem(key, payloadOf(value))
}

/** 取回草稿；没有、坏了、字段残缺都算没有（返回 null，绝不让坏稿把表单填成半截） */
export function loadDraft<T>(store: DraftStore, key: string): DraftRecord<T> | null {
  const raw = store.getItem(key)
  if (!raw) return null
  const d = parsePayload<T>(raw)
  if (!d) {
    // 坏稿当场清掉：留着它每次打开都白读一遍
    store.removeItem(key)
    return null
  }
  return d
}

/** 保存成功（或明确不要了）时清掉 */
export function clearDraft(store: DraftStore, key: string): void {
  store.removeItem(key)
}
