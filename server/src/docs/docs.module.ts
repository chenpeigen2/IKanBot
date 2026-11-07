import { Module } from '@nestjs/common'
import { DocsController } from './docs.controller'
import { DocsService } from './docs.service'
import { DocsStore } from './docs-store.service'

/** 单据存档只此一份：core/docs 是判据，这里只接 HTTP 与目录 */
@Module({
  controllers: [DocsController],
  providers: [DocsService, DocsStore],
  exports: [DocsService]
})
export class DocsModule {}
