/**
 * 图片文件 URL（同步）。本机模式是 file://，后端模式是 http(s)://——
 * 数据来源可以在设置里当场切换，所以基地址每次现取，不缓存。
 */
function readBase(): string {
  try {
    return window.api.images.baseDir()
  } catch {
    return ''
  }
}

export function initImageBase(): void {
  // 启动时探一次，让「主进程没起来」这种情况早早暴露，而不是等某张图裂开
  readBase()
}

export function imageUrl(fileName: string): string {
  if (!fileName) return ''
  const baseDir = readBase()
  if (!baseDir) return ''
  // 后端模式：基地址本身就是 HTTP 目录，文件名按 URL 段转义
  if (/^https?:/i.test(baseDir)) return `${baseDir.replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`
  const path = `${baseDir}/${fileName}`.replace(/\\/g, '/')
  // POSIX 的绝对路径要 file:// 前缀，Windows 的 D:/ 要 file:///；
  // 文件名里带空格 / # / ? 必须转义，否则 <img> 只会静默裂图
  const prefix = path.startsWith('/') ? 'file://' : 'file:///'
  return prefix + encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
