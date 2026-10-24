/**
 * afterPack 钩子：用 rcedit 给 exe 设置图标与版本信息。
 *
 * 为什么不走 electron-builder 内置流程：内置流程需要解压 winCodeSign，
 * 而该压缩包内含 macOS 符号链接，在未开启「开发者模式」的非管理员环境会失败。
 * 这里直接复用已解压出的 rcedit-x64.exe（Windows 工具，解压不受影响）。
 */
const { existsSync, readdirSync, statSync } = require('fs')
const { join } = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('module')

const require2 = createRequire(__filename)

function findRcedit() {
  const cacheRoot =
    process.env.ELECTRON_BUILDER_CACHE ||
    join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  const dir = join(cacheRoot, 'winCodeSign')
  if (!existsSync(dir)) return null
  const candidates = []
  for (const entry of readdirSync(dir)) {
    const exe = join(dir, entry, 'rcedit-x64.exe')
    if (existsSync(exe)) {
      try {
        candidates.push({ path: exe, mtime: statSync(exe).mtimeMs })
      } catch {
        /* ignore */
      }
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].path
}

exports.default = async function afterPack(context) {
  // 只处理 Windows 的 exe；macOS 的 .app 由 electron-builder 自己写 Info.plist 和图标。
  if (context.electronPlatformName !== 'win32') return

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = join(context.appOutDir, exeName)
  if (!existsSync(exePath)) {
    console.warn(`[afterPack] 找不到 ${exePath}，跳过图标设置`)
    return
  }

  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('[afterPack] 未找到 rcedit-x64.exe，跳过图标设置')
    return
  }

  const iconPath = join(context.packager.projectDir, 'build', 'icon.ico')
  if (!existsSync(iconPath)) {
    console.warn('[afterPack] 未找到 build/icon.ico，跳过图标设置')
    return
  }

  const { version } = require2('../package.json')
  const args = [exePath, '--set-icon', iconPath, '--set-version-string', 'FileDescription', 'IKanBot 外贸商品与单据系统']
  args.push('--set-file-version', version)
  args.push('--set-product-version', version)
  args.push('--set-version-string', 'ProductName', 'IKanBot')
  args.push('--set-version-string', 'CompanyName', 'IKan Trading')
  args.push('--set-version-string', 'LegalCopyright', 'IKan Trading Co., Ltd')

  try {
    // electron-builder 刚写完 exe，Windows 的文件句柄可能还没释放，
    // rcedit 会报 "Command failed"（不是权限问题，手动跑同一个 exe 是成功的）。
    // 重试几次并留出释放时间即可。
    let lastErr = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execFileSync(rcedit, args, { stdio: 'ignore' })
        console.log('[afterPack] 图标与版本信息已写入')
        return
      } catch (e) {
        lastErr = e
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},800)'], { stdio: 'ignore' })
      }
    }
    // 重试都失败：图标失败不影响打包结果
    console.warn(`[afterPack] 图标设置失败: ${lastErr && lastErr.message}`)
  } catch (e) {
    // 图标失败不影响打包结果
    console.warn(`[afterPack] 图标设置失败: ${e.message}`)
  }
}
