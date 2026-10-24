import { ipcMain } from 'electron'

/**
 * 包装 handler，统一错误传递。
 *
 * 渲染进程那一侧的 call() 只认 {ok,data} / {ok,error} 这个壳：
 * 谁绕开这个壳直接返回裸值，界面拿到的就是 `res.ok === undefined`，
 * 于是每个调用都变成一条「空消息的 Error」被静默丢掉——
 * 自动更新那几张按钮就是这么哑了很久的（点了没反应，也不报错）。
 * 所以壳只写在这一处，服务层不许自己 ipcMain.handle。
 */
export function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
