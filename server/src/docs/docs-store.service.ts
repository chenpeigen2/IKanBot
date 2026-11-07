import { Inject, Injectable } from '@nestjs/common'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { BizError } from '../../../src/shared/errors'
import { CONFIG } from '../config/config.module'
import type { ServerConfig } from '../config/config'

/**
 * 后端自己的单据存档目录（PDF）。文件名由 core/docs 按单号/版次拼，
 * 目录只负责守门：resolve 出来的路径必须落在 docsDir 里。
 */
@Injectable()
export class DocsStore {
  constructor(@Inject(CONFIG) private readonly config: ServerConfig) {}

  dir(): string {
    return this.config.docsDir
  }

  /** 给 core/docs 用：不存在就建（桌面端 docsDir() 同款语义） */
  ensure(): string {
    const dir = this.dir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 读取侧的最后一道门：桌面传来的相对路径 resolve 后必须落在存档目录里。
   * core/docs.resolveDocPath 已经把「盘符接回 / 拒目录外」做了一遍，这里再卡一道
   * ——读字节的入口在后端，路径守卫也要在后端守到底。
   */
  resolveInside(filePath: unknown): string {
    const raw = String(filePath ?? '').trim()
    if (!raw) throw new BizError('没有文件')
    const dir = resolve(this.ensure())
    const p = resolve(dir, raw.replace(/\\/g, '/').replace(/^\/+/, ''))
    if (!p.startsWith(dir + sep)) {
      throw new BizError('单据路径不在数据目录里，已拒绝打开')
    }
    return p
  }
}
