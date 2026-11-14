/* 只读审计（R88 新增）：IPC 通道三层接线对表——R83 复验人工做过一次的三层核对，这版自动化。
 * 层：① electron/ipc/index.ts 的 handle('domain:action')（主进程实现）
 *     ② electron/preload/index.ts 里 call('domain:action')（渲染层入口）
 *     ③ electron/remote/client.ts 的 REMOTE_ROUTES['domain:action']（远端转发表）
 *     ④ server 控制器路由（远端通道的服务端实现——与 audit:http 同源口径）
 * 硬闸：②里调的通道 ①必须有（点到了没实现 = 现场报错类 bug）；
 *       ③里转发的通道 ①必须有、④路由必须存在（远端模式打空气）。
 * 软清单：①里有而②没有的通道（内部用/预留死通道，逐条人审）；
 *         ①里有而③没有的 = 本地独有通道（覆盖率口径的本体，打印/对话框/窗口类按设计不上后端）。 */
const fs = require('fs')
const path = require('path')
const { stripComments, controllerRoutes, ROOT } = require('./lib/audit-shared.cjs')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const uniq = (arr) => [...new Set(arr)]

/** ① 主进程 handle 注册表——handle() 助手全仓通用（ipc/index.ts、services/updater.ts 等），
 *  扫整棵 electron/ 树；preload 除外（它那侧是 call 调用面，是另一层） */
function scanHandles() {
  const found = []
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) walk(p)
      else if (f.endsWith('.ts') && !p.includes('electron/preload')) {
        const src = fs.readFileSync(p, 'utf8')
        // handle() 异步注册 + handleSync() 同步注册（R88 复验收编：images:baseDir 走 handleSync，
        // 只扫 handle 会漏——静态口径要对齐运行时注册数）
        found.push(...[...src.matchAll(/\bhandle(?:Sync)?\((['"])([^'"]+)\1/g)].map((m) => m[2]))
      }
    }
  }
  walk(path.join(ROOT, 'electron'))
  return uniq(found)
}
const handles = scanHandles()

/** ② preload 调用面：call('...') 的通道字面量（剥注释后提取；stripComments 唯一真源在
 *  scripts/lib/audit-shared.cjs——R88 复验-2 小账「两份复制将来会分叉」的抽取） */
const preload = stripComments(read('electron/preload/index.ts'))
const preloadChannels = uniq([
  ...[...preload.matchAll(/call[^(]*\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]),
  // sendSync 旁路（R88 复验收编：images:baseDir 走 ipcRenderer.sendSync，call 正则看不见）
  ...[...preload.matchAll(/sendSync\((['"])([^'"]+)\1/g)].map((m) => m[2])
])

/** ③ 远端转发表 */
const remoteSrc = read('electron/remote/client.ts')
const remoteRoutes = uniq([...remoteSrc.matchAll(/(['"])([a-z]+:[a-zA-Z0-9]+)\1\s*:\s*\{/g)].map((m) => m[2]))

/** ④ server 控制器路由（唯一真源在 scripts/lib/audit-shared.cjs——与 audit:http 同一函数） */
const serverRoutes = controllerRoutes().map((r) => r.route)

console.log('主进程 handle:', handles.length, '· preload 调用通道:', preloadChannels.length, '· REMOTE_ROUTES:', remoteRoutes.length, '· server 路由:', serverRoutes.length)

let bad = 0
/** 硬闸 A：preload 调的通道必须有 handle */
const missingHandle = preloadChannels.filter((c) => !handles.includes(c))
if (missingHandle.length) {
  bad++
  console.log('--- 硬闸 A：preload 调了但没有 handle（点到就现场报错） ---')
  for (const c of missingHandle) console.log(c)
}
/** 硬闸 B：REMOTE_ROUTES 转发的通道必须有 handle 且 server 路由存在 */
const remoteMissingHandle = remoteRoutes.filter((c) => !handles.includes(c))
if (remoteMissingHandle.length) {
  bad++
  console.log('--- 硬闸 B1：REMOTE_ROUTES 转发但没有 handle ---')
  for (const c of remoteMissingHandle) console.log(c)
}
const remotePaths = [...remoteSrc.matchAll(/(['"])([a-z]+:[a-zA-Z0-9]+)\1\s*:\s*\{\s*path:\s*(['"])([^'"]+)\3/g)].map((m) => ({ ch: m[2], path: m[4] }))
/** 硬闸 B0（R90 加）：条目数与路径提取数必须相等——B2 的正则要求 path 是入口第一个字段，
 *  字段重排的条目会掉出 remotePaths、B2 对它失明且不吭声（复验-2 小账）。有差当场报红。 */
if (remotePaths.length !== remoteRoutes.length) {
  bad++
  console.log(`--- 硬闸 B0：REMOTE_ROUTES 条目 ${remoteRoutes.length} 与路径提取 ${remotePaths.length} 不等——有条目掉出口径（查 path 是否不在入口首字段/引号变体） ---`)
}
const missingServerRoute = remotePaths.filter((r) => !serverRoutes.includes(r.path))
if (missingServerRoute.length) {
  bad++
  console.log('--- 硬闸 B2：REMOTE_ROUTES 的路径 server 控制器里不存在（远端打空气） ---')
  for (const r of missingServerRoute) console.log(`${r.ch} → ${r.path}`)
}
/** 软清单 C：handle 有但 preload 没暴露（死通道候选，人审） */
const notExposed = handles.filter((c) => !preloadChannels.includes(c))
console.log('--- 软清单 C：handle 有但 preload 没暴露（死通道候选，人审） ---')
console.log(notExposed.length === 0 ? '（无）' : notExposed.join('\n'))
/** 软清单 D：本地独有通道（handle 有但 REMOTE_ROUTES 没有）——覆盖率口径的本体 */
const localOnly = handles.filter((c) => !remoteRoutes.includes(c))
console.log('--- 软清单 D：本地独有通道（不上后端；含 mode:/updater: 前缀豁免——app 覆盖率口径的 22 条业务未覆盖是这里的子集） ---')
console.log(`共 ${localOnly.length} 条：` + localOnly.join(', '))
if (bad > 0) process.exitCode = 1
