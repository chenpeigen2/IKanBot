import { Module } from '@nestjs/common'
import { BackupController } from './backup.controller'
import { BackupService } from './backup.service'

/** 备份只此一份：core/backup 是判据，这里只接 HTTP、目录与定时器 */
@Module({
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService]
})
export class BackupModule {}
