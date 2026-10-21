/**
 * 生成演示用商品占位图（R2-P6）。
 * 之前 data/images/seed-*.png 是"两根蓝条"，长得跟浏览器断图标一模一样，
 * 审查官把它当成了裂图。这里生成"浅灰底 + 简单衣服剪影"的占位图，一眼看出是占位。
 * 零依赖：手写 PNG（zlib 是 Node 内置）。
 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 画一件简单的 T 恤剪影（多边形 + 领口挖空），返回是否在形状内 */
function inShirt(x, y, S) {
  const p = (n) => n * S
  // 衣身梯形 + 两只袖子（粗略但一眼能认出是件衣服）
  const body = [
    [0.3, 0.26],
    [0.7, 0.26],
    [0.74, 0.34],
    [0.7, 0.92],
    [0.3, 0.92],
    [0.26, 0.34]
  ]
  const sleeveL = [
    [0.3, 0.26],
    [0.12, 0.36],
    [0.2, 0.52],
    [0.3, 0.44]
  ]
  const sleeveR = [
    [0.7, 0.26],
    [0.88, 0.36],
    [0.8, 0.52],
    [0.7, 0.44]
  ]
  const poly = (pts) => {
    let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = p(pts[i][0]),
        yi = p(pts[i][1]),
        xj = p(pts[j][0]),
        yj = p(pts[j][1])
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  if (poly(sleeveL) || poly(sleeveR)) return true
  if (!poly(body)) return false
  // 领口：椭圆挖空
  const cx = p(0.5),
    cy = p(0.27),
    rx = p(0.09),
    ry = p(0.05)
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1
}

function make(size, clothRgb) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      let [r, g, b] = [238, 241, 245] // 浅灰蓝底
      // 1px 边框
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) [r, g, b] = [190, 197, 208]
      else if (inShirt(x + 0.5, y + 0.5, size)) [r, g, b] = clothRgb
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = 255
    }
  }
  return png(size, size, buf)
}

const dir = path.join(__dirname, '..', 'data', 'images')
fs.mkdirSync(dir, { recursive: true })
const outs = [
  ['seed-ts001.png', [92, 108, 132]], // 深灰蓝（T恤）
  ['seed-pl002.png', [110, 140, 118]], // 灰绿（POLO）
  ['seed-sh003.png', [140, 155, 180]] // 浅灰蓝（衬衫）
]
for (const [name, rgb] of outs) {
  fs.writeFileSync(path.join(dir, name), make(160, rgb))
  console.log('已生成', name)
}
