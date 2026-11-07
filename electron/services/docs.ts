/**
 * 单据存档的桌面门面：真正的判据（版次、指纹、CI 重叠、路径守卫）在 core/docs.ts，
 * 桌面与后端共用同一份（R60 起后端模式也能存档）。这里只负责把本机的数据目录接上去。
 */
import { coreDb, dataDir, docsDir } from '../db'
import { docsCore } from '../../core/docs'

export type { DocVersion } from '../../core/docs'
export { assertDocKind } from '../../core/docs'

const core = docsCore(coreDb, { dataDir, docsDir })

export const nextVersion = core.nextVersion
export const recordDocVersion = core.recordDocVersion
export const voidDocVersion = core.voidDocVersion
export const saveDocFile = core.saveDocFile
export const resolveDocPath = core.resolveDocPath
export const listDocVersions = core.listDocVersions
export const listQuotationDocVersions = core.listQuotationDocVersions
export const assertCiNoOverlap = core.assertCiNoOverlap
