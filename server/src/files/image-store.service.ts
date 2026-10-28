import { Inject, Injectable } from '@nestjs/common'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BizError } from '../../../core/errors'
import { CONFIG } from '../config/config.module'
import type { ServerConfig } from '../config/config'

/** 一张商品图 20MB 封顶：再大就是没压缩的原片，传上去打印也用不上 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  // 公司 Logo 允许 SVG：纸面是按 data URL 塞进 <img> 里印的，脚本不会执行
  svg: 'image/svg+xml'
}

/**
 * 后端自己的图片目录。文件名是服务器生成的 UUID，
 * 客户端传上来的名字只用来取扩展名——省得有人用 `../../x` 写到目录外。
 */
@Injectable()
export class ImageStore {
  constructor(@Inject(CONFIG) private readonly config: ServerConfig) {}

  dir(): string {
    return this.config.imagesDir
  }

  /** 只认纯文件名；目录外的路径一律不认 */
  resolveName(name: unknown): string | null {
    const n = basename(String(name ?? '').trim())
    if (!n || n === '.' || n === '..') return null
    const dir = resolve(this.dir())
    const p = resolve(dir, n)
    if (!p.startsWith(dir + sep)) return null
    return p
  }

  save(bytes: Buffer, originalName: string): string {
    const ext = extname(basename(originalName)).replace('.', '').toLowerCase()
    if (!MIME[ext]) {
      throw new BizError(`不认这种图片格式（${ext ? '.' + ext : '没有扩展名'}）：只接 JPG、PNG、WebP、GIF、SVG。`)
    }
    if (bytes.length === 0) throw new BizError('图片内容是空的')
    mkdirSync(this.dir(), { recursive: true })
    const name = `${randomUUID()}.${ext}`
    writeFileSync(join(this.dir(), name), bytes)
    return name
  }

  read(name: unknown): Buffer | null {
    const p = this.resolveName(name)
    if (!p || !existsSync(p)) return null
    return readFileSync(p)
  }

  mimeOf(name: unknown): string {
    const ext = extname(String(name ?? '')).replace('.', '').toLowerCase()
    return MIME[ext] ?? 'application/octet-stream'
  }

  remove(name: unknown): boolean {
    const p = this.resolveName(name)
    if (!p || !existsSync(p)) return false
    try {
      unlinkSync(p)
      return true
    } catch {
      // 删不掉不挡主流程：库里的登记已经清了，文件下回手工收拾
      return false
    }
  }
}
