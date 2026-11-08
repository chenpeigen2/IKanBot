import { useEffect, useRef, useState } from 'react'

export interface StaleSnapshotInfo {
  /** 别人那笔写的时间（读不到就 null，提示里不带时间） */
  changedAt: string | null
}

/**
 * 弱提示（M4 第二片，R63）：详情/编辑面开着的时候，静默盯一眼别人改没改——
 * 每 30 秒（外加窗口重新聚焦的瞬间）拉一次最新的 row_version，比你手里快照的新就算「旧了」。
 * 不做长连接，不阻断保存：真要保存时服务端的 CAS（expectedRowVersion）才是闸门，
 * 这里只是提前打个招呼，别等 409 才知道。
 *
 * 刷新即消：界面重拉快照（current 的 row_version 变了）后 effect 重跑，比对自然归位。
 * 轮询失败（断网/登录过期）不打扰人——弱提示是锦上添花，闭嘴比报错合适，闸门在保存那一刻。
 */
export function useStaleSnapshot(
  current: { rowVersion?: number | null } | null | undefined,
  fetchFresh: () => Promise<{ rowVersion?: number | null; updatedAt?: string | null } | null>,
  enabled: boolean
): StaleSnapshotInfo | null {
  const [stale, setStale] = useState<StaleSnapshotInfo | null>(null)
  /** ref 存最新值：定时器回调读到的是当下而不是挂定时器那一刻的快照 */
  const verRef = useRef<number | null | undefined>(current?.rowVersion)
  verRef.current = current?.rowVersion
  const fetchRef = useRef(fetchFresh)
  fetchRef.current = fetchFresh

  useEffect(() => {
    if (!enabled) {
      setStale(null)
      return
    }
    let alive = true
    let running = false
    const peek = async () => {
      if (running) return // 上一趟没回来就别叠着发
      running = true
      try {
        const fresh = await fetchRef.current()
        if (!alive) return
        const mine = verRef.current
        if (
          fresh &&
          typeof fresh.rowVersion === 'number' &&
          typeof mine === 'number' &&
          fresh.rowVersion > mine
        ) {
          setStale({ changedAt: fresh.updatedAt ?? null })
        } else {
          setStale(null)
        }
      } catch {
        // 拉不到就这轮不说：30 秒后或下次聚焦再看
      } finally {
        running = false
      }
    }
    const timer = window.setInterval(peek, 30000)
    const onFocus = () => void peek()
    window.addEventListener('focus', onFocus)
    // 打开面（或快照刚换）先盯一次：刚打开就被人改过也要马上说
    void peek()
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, current?.rowVersion])

  return stale
}
