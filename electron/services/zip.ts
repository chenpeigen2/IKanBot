import { deflateRawSync, inflateRawSync } from 'zlib'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, basename } from 'path'

export interface ZipEntry {
  name: string
  data: Buffer
}

/**
 * 最小 ZIP 写入器（store + deflate），仅实现导出备份所需的功能。
 * 避免引入 archiver 依赖，同时保持纯 JS。
 */

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

export function createZip(entries: ZipEntry[]): Buffer {
  // ZIP 中央目录的条目数是 16 位字段：超限后 writeUInt16LE 会抛英文 RangeError，
  // 提前拦下来把话说清。图片和单据存档是收款/退税凭据，文案不能让人去删。
  if (entries.length > 65535) {
    throw new Error(
      `备份内容有 ${entries.length} 个文件，超过单个备份包 65535 的上限，备份没有生成。` +
        `图片和单据存档都是重要凭据，请不要删除；请清理重复/废弃的附件，或联系技术支持做分卷备份。`
    )
  }
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const now = new Date()
  const { time, date } = dosDateTime(now)

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const compressed = deflateRawSync(entry.data, { level: 9 })
    const useDeflate = compressed.length < entry.data.length
    const body = useDeflate ? compressed : entry.data
    const method = useDeflate ? 8 : 0

    // ZIP32 的体积/偏移都是 32 位无符号字段：越过 4GB 后 writeUInt32LE 会静默截断，
    // 生成一个自己都读不回来的包。宁可在写到这里时停下来把话说清
    if (offset + 30 + nameBuf.length + body.length > 0xffffffff || entry.data.length > 0xffffffff) {
      throw new Error(
        `备份内容超过单个备份包 4GB 的上限（写到「${entry.name}」时越线），备份没有生成。` +
          `图片和单据存档都是重要凭据，请不要删除；请清理重复/废弃的附件，或联系技术支持做分卷备份。`
      )
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 flag
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(entry.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuf, end])
}

/** 操作系统那几个错误码没人会读：给一句人话，原码留在括号里方便查 */
const FS_ERROR_ZH: Record<string, string> = {
  ENOENT: '文件已经不在了（可能刚被删掉）',
  ENOTDIR: '路径上有同名的文件挡着',
  EBUSY: '文件正被别的程序占用',
  EPERM: '没有权限读这个文件',
  EACCES: '没有权限读这个文件',
  ENAMETOOLONG: '文件路径太长了',
  ELOOP: '文件夹里套着软链，绕回来了'
}

export function zhFsError(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  const zh = err?.code ? FS_ERROR_ZH[err.code] : undefined
  return zh ? `${zh}（${err.code}）` : String((e as Error)?.message ?? e)
}

/**
 * 收集目录内所有文件为 zip 条目。
 *
 * 单个文件读不了（正被删、被占用、没权限）不该把整场备份带走：跳过它、记进 skipped，
 * 由备份服务决定怎么留痕。但「跳过」绝不能等同于「成功」——少了几张图、几个 PDF 的包
 * 也要如实告诉人，否则出事那天翻备份，以为备份里什么都有。
 */
export function collectDir(dir: string, prefix: string, skipped: string[] = []): ZipEntry[] {
  if (!existsSync(dir)) return []
  const out: ZipEntry[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (e) {
    skipped.push(`${prefix}/：整个目录读不出来 —— ${zhFsError(e)}`)
    return out
  }
  for (const f of names) {
    const p = join(dir, f)
    try {
      if (statSync(p).isDirectory()) {
        // 单据按单号分子目录：备份必须把子目录里的 PDF 一起带上
        out.push(...collectDir(p, `${prefix}/${f}`, skipped))
      } else {
        out.push({ name: `${prefix}/${f}`, data: readFileSync(p) })
      }
    } catch (e) {
      skipped.push(`${prefix}/${f} —— ${zhFsError(e)}`)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 读侧：从 zip 里把条目取回来
 * ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** EOCD 定长 22 字节，前面最多还能挂 64KB 注释，所以只往回找这么多 */
const EOCD_MAX_BACK = 22 + 0xffff

/**
 * 逐个读出压缩包里的条目（解压一个、给一个，不留全量在内存里）。
 *
 * 校验强度按「这份备份能不能拿去恢复」的标准来：
 * 目录结构越界、解压失败、大小不符、CRC 对不上——任何一种都是硬伤，
 * 直接抛，绝不返回半截数据。备份最怕的不是没备成，而是以为备成了。
 */
function forEachZipEntry(buf: Buffer, onEntry: (name: string, data: Buffer) => void): void {
  if (buf.length < 22) throw new Error('这个文件太小了，不像是一个完整的备份包')
  let eocd = -1
  const floor = Math.max(0, buf.length - EOCD_MAX_BACK)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new Error('备份包结尾的目录信息不见了：文件被截断或写坏了，这个包不能用')
  }
  const count = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  const dirOffset = buf.readUInt32LE(eocd + 16)
  if (dirOffset + dirSize > eocd) throw new Error('备份包的目录信息越界了：文件已损坏，这个包不能用')

  let p = dirOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`备份包里第 ${i + 1} 条目录记录读不出来：文件已损坏`)
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    // 数据真正的位置要回到本地文件头去算（那里的文件名/附加区长度可能不一样）
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) {
      throw new Error(`备份包里的「${name}」找不到对应的位置：文件已损坏`)
    }
    if ((flags & 0x0008) !== 0) {
      throw new Error(`备份包里的「${name}」用了流式写法，本程序读不了`)
    }
    const localNameLen = buf.readUInt16LE(localOff + 26)
    const localExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buf.length) {
      throw new Error(`备份包里的「${name}」内容不完整：写到一半就断了`)
    }
    const body = buf.slice(dataStart, dataStart + compSize)

    let data: Buffer
    if (method === 0) data = body
    else if (method === 8) {
      try {
        data = inflateRawSync(body)
      } catch {
        throw new Error(`备份包里的「${name}」解不开：文件已损坏`)
      }
    } else {
      throw new Error(`备份包里的「${name}」用了不认识的压缩方式（编号 ${method}）`)
    }
    if (data.length !== uncompSize) {
      throw new Error(`备份包里的「${name}」大小不对：说好 ${uncompSize} 字节，实际 ${data.length}`)
    }
    if (crc32(data) !== crc) {
      throw new Error(`备份包里的「${name}」校验码对不上：内容已经损坏，这个包不能用来恢复`)
    }
    onEntry(name, data)
  }
}

export function readZip(buf: Buffer): ZipEntry[] {
  const out: ZipEntry[] = []
  forEachZipEntry(buf, (name, data) => out.push({ name, data }))
  return out
}

/**
 * 验货：把刚落盘的包逐条读回来，和解包前手上的那份逐字节比对。
 * 名字对不上（少了一张图、少了一个 PDF）也算失败——备份的用途是「出事时能全须全尾回来」，
 * 少一个文件就是少一个凭据。
 */
export function verifyZip(buf: Buffer, expected: ZipEntry[]): void {
  const want = new Map(expected.map((e) => [e.name, e.data]))
  const got = new Set<string>()
  forEachZipEntry(buf, (name, data) => {
    if (got.has(name)) throw new Error(`备份包里「${name}」出现了两次`)
    got.add(name)
    const origin = want.get(name)
    if (!origin) throw new Error(`备份包里多出一个没打算装进去的文件：「${name}」`)
    if (!origin.equals(data)) throw new Error(`备份包里的「${name}」和原始内容不一致`)
    want.delete(name)
  })
  const missing = [...want.keys()]
  if (missing.length > 0) {
    throw new Error(`备份包里少了 ${missing.length} 个文件（例如「${missing[0]}」）——这个包不完整，不要用`)
  }
}

export { basename }
