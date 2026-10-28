import { Body, Controller, Header, HttpCode, Post } from '@nestjs/common'
import { SettingsService } from './settings.service'
import { objectParam } from '../common/params'

/** 路由名 = IPC 通道名（settings:get → POST /api/settings/get）。 */
@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Post('get')
  @HttpCode(200)
  get() {
    return this.settings.get()
  }

  @Post('save')
  @HttpCode(200)
  save(@Body() body: Record<string, unknown>) {
    return this.settings.save(objectParam(body['input'], '设置内容'))
  }

  /** 只回一个布尔值：不声明 JSON 类型时，Express 会把 true 当 HTML 文本发出去 */
  @Post('baseLocked')
  @HttpCode(200)
  @Header('content-type', 'application/json; charset=utf-8')
  baseCurrencyLocked() {
    return this.settings.baseCurrencyLocked()
  }
}
