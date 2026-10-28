import { Global, Module } from '@nestjs/common'
import { loadConfig } from './config'

export const CONFIG = 'IKAN_CONFIG'

@Global()
@Module({
  // 用 factory 而不是 useValue：测试要在建 app 之前改环境变量指到临时库
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG]
})
export class ConfigModule {}
