import { ipcMain } from 'electron'
import { isRemoteMode } from '../mode'
import { coverageWords, isRemoteChannel, remoteCall } from '../remote/client'
import { isRestoring } from '../services/backup'

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
  // docs: 的读侧四条已上后端（REMOTE_ROUTES）；save/reveal/openFile 三条是
  // 「PDF 生成 + 开本机文件」的本机事务，各自在 handler 里按模式分流
  'backup:',
  'export:',
  'updater:',
  'mode:'
]

/**
 * 只在远端模式也走本机的单个通道。
 * docs:save（PDF 由本机 Chromium 生成后上传）、docs:reveal / docs:openFile
 * （下载字节到本机临时文件再开）——它们不走 remoteCall 的 JSON 转发，
 * 分流写在 ipc/index.ts 自己的 handler 里。
 * （products:csvTemplate 只是返回表头常量。）
 */
const LOCAL_ONLY_CHANNELS = new Set(['products:csvTemplate', 'docs:save', 'docs:reveal', 'docs:openFile'])

/** 这个通道是不是「天生只在本机」——测试用它盯着「业务接口有没有漏登记后端路由」 */
export function isLocalOnlyChannel(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel) || LOCAL_ONLY.some((p) => channel.startsWith(p))
}

/** 注册过的通道名：设置页要报「已搬到后端几个」，不能靠手抄的数字 */
const registered = new Set<string>()

/**
 * 同步通道（ipcRenderer.sendSync）也要进账：以前 images:baseDir 走 sendSync 旁路，
 * 注册清单里看不见它，覆盖率与「有没有漏登记」的检查都接不到（R46 挂账，R60 收编）。
 * 壳与 handle() 一致：{ ok, data } / { ok, error }。
 */
export function handleSync(channel: string, fn: () => unknown): void {
  registered.add(channel)
  handlerArityOf.set(channel, fn.length)
  ipcMain.on(channel, (e) => {
    try {
      e.returnValue = { ok: true, data: fn() }
    } catch (err) {
      e.returnValue = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
/**
 * 每条通道 handler 声明的形参个数。远端模式下参数是按位置映射成 body 字段的，
 * 路由表登记的参数名比形参少，多出来的那几个就被丢掉——本机拦住的话术
 * 到了后端就成了「没填」，同一句话术两张嘴（R56）。
 */
const handlerArityOf = new Map<string, number>()

export function registeredChannels(): string[] {
  return [...registered]
}

/** handler 声明了几个形参（没注册过给 0） */
export function handlerArity(channel: string): number {
  return handlerArityOf.get(channel) ?? 0
}

/**
 * 恢复备份期间还放行的通道：只剩「看备份、关窗口、切数据源、让程序重启」。
 * 其余一律挡住。原因不是怕写坏磁盘，是怕写了也白写：
 * restoreBackup 里 `await createBackup('pre-restore')` 会交出事件循环，
 * 排队中的存档/建单请求正好插进来提交进旧库，紧接着旧库整个被备份包盖掉——
 * 界面那头收到的是「保存成功」，重启后那条记录连个影子都没有。
 * 宁可让按钮响一声「等一下」，也不能让它撒这个谎。
 */
const RESTORE_ALLOWED = ['backup:', 'app:', 'window:', 'mode:']

function isRestoreAllowed(channel: string): boolean {
  return RESTORE_ALLOWED.some((p) => channel.startsWith(p))
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
  handlerArityOf.set(channel, fn.length)
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      if (isRestoring() && !isRestoreAllowed(channel)) {
        throw new Error(
          '正在恢复备份，程序马上要重启，这一步先停一停。\n' +
            '这会儿写进去的记录会被恢复覆盖掉——界面报了「保存成功」，重启以后却找不到，比直接失败更坑。'
        )
      }
      if (isRemoteMode() && !isLocalOnlyChannel(channel)) {
        if (!isRemoteChannel(channel)) {
          throw new Error(
            `「${channel}」这个功能还没搬到后端，现在只有本机版。\n` +
              `${coverageWords()}；备份、打印这些还在本机。\n` +
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
