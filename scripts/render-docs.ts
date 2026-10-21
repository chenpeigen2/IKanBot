/** 渲染各单据 HTML，供人工核对版式。 */
import { openDb, closeDb } from '../electron/db'
import { getSettings } from '../electron/services/settings'
import * as quotations from '../electron/services/quotations'
import * as orders from '../electron/services/orders'
import { renderPi, renderPl, renderQuotation, renderCi } from '../src/shared/documents'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

async function main() {
  openDb()
  const settings = getSettings()
  const dir = join(process.cwd(), 'out', 'shots')
  mkdirSync(dir, { recursive: true })

  const qs = quotations.listQuotations({})
  if (qs.length > 0) {
    const q: any = quotations.getQuotation(qs[0].id)
    writeFileSync(join(dir, 'quotation.html'), renderQuotation({ quotation: q, settings, images: {} } as any))
    console.log('报价单 HTML 已导出')
  }

  const os = orders.listOrders({})
  if (os.length > 0) {
    const o: any = os[0]
    writeFileSync(join(dir, 'pi.html'), renderPi({ order: o, settings, images: {} } as any))
    writeFileSync(join(dir, 'ci.html'), renderCi({ order: o, settings, images: {} } as any))
    console.log('PI / CI HTML 已导出')
    if (o.packingLists.length > 0) {
      writeFileSync(join(dir, 'pl.html'), renderPl({ order: o, settings, images: {} } as any, o.packingLists[0]))
      console.log('PL HTML 已导出')
    }
  }
  closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
