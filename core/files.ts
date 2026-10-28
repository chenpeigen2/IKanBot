/**
 * 图片删除前的「库里还有人引用吗」：桌面与后端共用这一份判据。
 *
 * images:discard（桌面）与 files/discard（后端）这两条通道的终点都是 unlink 一张真实文件，
 * 本意是给「批量上传传到一半失败」收尾——传上去了但没登记进库的文件得清掉，
 * 不然备份会把孤儿一张不落地打包。
 * 可名字是调用方传上来的：混进一张已经在用的（或者哪天有 bug 把在用的当草稿传了），
 * 商品图、订单照片、公司 Logo 就永久没了——记录还在库里，图没了，
 * 单据抬头一片空白、退税纠纷时要看的照片打不开。删除不可逆，所以在这里把不该删的挡下来。
 */
import { settingsCore } from './settings'
import type { Db } from './db'

/**
 * 名字归一到裸文件名：删除端（桌面 safeImage / 服务端 store.remove）都是先取 basename
 * 再落地的，判据必须落在同一个口径上。
 * 否则传 'dir/uuid.jpg' 或图片 URL 进来时这里查不中引用（库里存的是裸名），
 * 调用方却照样把那张在用的图删了——记录还在，图永久没了。
 */
function bareName(raw: unknown): string {
  const noQuery = String(raw ?? '').split(/[?#]/)[0]
  return (noQuery.split(/[\\/]/).pop() ?? '').trim()
}

export function filesCore(db: Db) {
  /** 给一批文件名，返回其中确实被库引用的那些；调用方只许删剩下的 */
  const referenced = async (names: unknown): Promise<Set<string>> => {
    const list = [...new Set((Array.isArray(names) ? names : []).map(bareName).filter((n) => !!n))]
    if (list.length === 0) return new Set()
    // 占位符按个数拼，名字一律走参数，不当 SQL 片段使
    const marks = list.map(() => '?').join(',')
    const rows = await db.all(
      `SELECT file_name AS n FROM product_images WHERE file_name IN (${marks})
       UNION SELECT file_name FROM order_photos WHERE file_name IN (${marks})`,
      [...list, ...list]
    )
    const out = new Set(rows.map((r) => String(r['n'])))
    const logo = (await settingsCore(db).get()).company.logoFile
    if (logo && list.includes(bareName(logo))) out.add(bareName(logo))
    return out
  }

  const normalize = (names: unknown): string[] => [
    ...new Set((Array.isArray(names) ? names : []).map(bareName).filter((n) => !!n))
  ]

  return {
    referenced,
    /**
     * 这批名字里哪些可以安全删除（已归一成裸名）。
     * 把「问库」和「归一」一起给出去，调用方就不必自己再算一遍 basename——
     * 两个 runtime 各归各的正是口径漂移的起点。
     */
    deletable: async (names: unknown): Promise<string[]> => {
      const list = normalize(names)
      if (list.length === 0) return []
      const inUse = await referenced(list)
      return list.filter((n) => !inUse.has(n))
    }
  }
}

export type FilesCore = ReturnType<typeof filesCore>
