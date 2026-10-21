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
  const path = `${baseDir}\\${fileName}`.replace(/\\/g, '/')
  return `file:///${path}`
}
