import { Inject, Injectable } from '@nestjs/common'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DB } from '../db/db.module'
import type { Db } from '../db/types'
import { docsCore, type DocVersion } from '../../../core/docs'
import { notFound } from '../../../src/shared/errors'
import { DocsStore } from './docs-store.service'

/**
 * 单据存档域的 HTTP 门面：版次、纸面指纹、CI 重叠、路径守卫全在 core/docs.ts，
 * 桌面走同一份（R60 起远端模式也能存档，存档账不再两本）。
 * PDF 生成仍由桌面出（HTML→PDF 要 Chromium），字节经 HTTP 传上来落在这里的 docs 目录。
 */
@Injectable()
export class DocsService {
  private readonly core: ReturnType<typeof docsCore>

  constructor(@Inject(DB) db: Db, private readonly store: DocsStore) {
    this.core = docsCore(db, {
      dataDir: () => dirname(this.store.dir()),
      docsDir: () => this.store.ensure()
    })
  }

  save(pdf: Buffer, meta: Record<string, unknown>): Promise<{ filePath: string; version: number }> {
    const saved = this.core.saveDocFile({
      pdf,
      docNo: String(meta['docNo'] ?? ''),
      kind: String(meta['kind'] ?? ''),
      orderId: meta['orderId'] == null ? null : Number(meta['orderId']),
      quotationId: meta['quotationId'] == null ? null : Number(meta['quotationId']),
      amount: meta['amount'] == null ? undefined : Number(meta['amount']),
      expectedVersion: meta['expectedVersion'] == null ? undefined : Number(meta['expectedVersion']),
      pageFingerprint: meta['pageFingerprint'] == null ? undefined : String(meta['pageFingerprint']),
      confirmOverlap: meta['confirmOverlap'] === true
    })
    // 绝对路径不外泄：桌面只拿相对路径与版本号（与桌面本机行为一致）
    return saved.then((s) => ({ filePath: s.filePath, version: s.version }))
  }

  list(orderId: number): Promise<DocVersion[]> {
    return this.core.listDocVersions(Number(orderId))
  }

  listQuotation(quotationId: number): Promise<DocVersion[]> {
    return this.core.listQuotationDocVersions(Number(quotationId))
  }

  void(versionId: number, reason?: string): Promise<DocVersion[]> {
    return this.core.voidDocVersion(Number(versionId), String(reason ?? ''))
  }

  nextVersion(docNo: unknown, kind: unknown): Promise<number> {
    return this.core.nextVersion(String(docNo ?? ''), String(kind ?? ''))
  }

  /** 读字节：先过 core 的路径判据，再确认文件真的还在（手工删了要说人话） */
  read(filePath: unknown): Buffer {
    const abs = this.core.resolveDocPath(String(filePath ?? ''))
    this.store.resolveInside(abs)
    if (!existsSync(abs)) {
      throw notFound('文件已不存在（可能被手工删了）')
    }
    return readFileSync(abs)
  }
}
