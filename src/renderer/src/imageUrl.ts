/** 图片文件 URL（同步）。file:// URL 可直接用于 <img src>。 */
let baseDir = ''

export function initImageBase(): void {
  try {
    baseDir = window.api.images.baseDir()
  } catch {
    baseDir = ''
  }
}

export function imageUrl(fileName: string): string {
  if (!fileName) return ''
  if (!baseDir) baseDir = window.api.images.baseDir()
  if (!baseDir) return ''
  const path = `${baseDir}/${fileName}`.replace(/\\/g, '/')
  // POSIX 的绝对路径要 file:// 前缀，Windows 的 D:/ 要 file:///；
  // 文件名里带空格 / # / ? 必须转义，否则 <img> 只会静默裂图
  const prefix = path.startsWith('/') ? 'file://' : 'file:///'
  return prefix + encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')
}
