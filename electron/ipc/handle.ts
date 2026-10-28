import { ipcMain } from 'electron'
import { isRemoteMode } from '../mode'
import { coverageWords, isRemoteChannel, remoteCall } from '../remote/client'

/**
 * 这些通道天生只能在本机做：开文件框、出 PDF、写备份包、装更新、还有「改去哪找数据」本身。
 * 远端模式下它们照旧走本机实现——把打印送去服务器没有任何意义。
 * 设置本身不在此列：公司抬头、收款账户、提醒阈值是后端那份账的一部分，跟着模式走。
 */
const LOCAL_ONLY = [
  'app:',
  'shell:',
  'images:',
  'window:',
  'docs:',
  'backup:',
  'export:',
  'updater:',
  'mode:'
]

/**
 * 只在远端模式也走本机的单个通道：本身不碰数据，没必要为它多一趟网络。
 * （products:csvTemplate 只是返回表头常量。）
 */
const LOCAL_ONLY_CHANNELS = new Set(['products:csvTemplate'])

/** 注册过的通道名：设置页要报「已搬到后端几个」，不能靠手抄的数字 */
const registered = new Set<string>()

export function registeredChannels(): string[] {
  return [...registered]
}

/**
 * 包装 handler，统一错误传递。
 *
 * 渲染进程那一侧的 call() 只认 {ok,data} / {ok,error} 这个壳：
 * 谁绕开这个壳直接返回裸值，界面拿到的就是 `res.ok === undefined`，
 * 于是每个调用都变成一条「空消息的 Error」被静默丢掉——
 * 自动更新那几张按钮就是这么哑了很久的（点了没反应，也不报错）。
 * 所以壳只写在这一处，服务层不许自己 ipcMain.handle。
 *
 * 远端模式的分流也在这里：登记过后端路由的通道转给后端，
 * 本地基建照旧，其余一律当场报错——不能让一半数据在服务器、一半在本机还装作没事。
 */
export function handle<T>(channel: string, fn: (...args: any[]) => T | Promise<T>): void {
  registered.add(channel)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      if (
        isRemoteMode() &&
        !LOCAL_ONLY_CHANNELS.has(channel) &&
        !LOCAL_ONLY.some((p) => channel.startsWith(p))
      ) {
        if (!isRemoteChannel(channel)) {
          throw new Error(
            `「${channel}」这个功能还没搬到后端，现在只有本机版。\n` +
              `${coverageWords()}；客户统计、单据存档、备份这些还在本机。\n` +
              `要用它，请到「设置 · 数据来源」切回「本机」。`
          )
        }
        return { ok: true, data: await remoteCall(channel, args) }
      }
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
