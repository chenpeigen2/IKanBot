import { Module } from '@nestjs/common'
import { FilesController } from './files.controller'
import { ImageStore } from './image-store.service'

/** 图片存储只此一份：商品模块删图时也走这里，路径守门不会两边各写一遍 */
@Module({
  controllers: [FilesController],
  providers: [ImageStore],
  exports: [ImageStore]
})
export class FilesModule {}
