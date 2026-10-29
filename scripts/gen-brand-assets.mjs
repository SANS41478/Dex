#!/usr/bin/env node
/**
 * 生成界面用品牌资产
 * ---------------------------------------------------------------------------
 * 为什么不是「复制一份」：
 *   品牌源图 `dex-logo-mono-white-2048.png` 是 2048² RGBA，**387 KB**。
 *   界面上它只被两个地方用到，最大显示 44px（空状态标志；TitleBar 是 20px）：
 *     .brand-mark             20px
 *     .conversation-empty-logo 44px
 *   直接把 2048² 复制进 renderer，等于让每个构建产物背 387 KB 去画一个 20px 的
 *   mask —— 实测构建日志里那一行就是 `dex-logo-mono-*.png 387.89 kB`。
 *   2240px 的宽高在 20px 上一像素也用不到。
 *
 *   所以这里做**降采样到 256²**：44px 在 3x DPI 下需要 132px，256 还有近 2 倍余量。
 *
 * 为什么不用 sharp / jimp：
 *   不值得为一个「缩小一张图」引入原生依赖。PNG 是无损 + zlib，Node 自带 zlib，
 *   解码→box 滤波→编码一共百来行，且行为完全可复现。
 *
 * 为什么输出恒为「纯白 + alpha」：
 *   资产只作为 CSS mask 的轮廓源，颜色由 `background-color` 决定。
 *   纯白让 RGB 通道完全均匀 → 压缩率极高，同时让资产的含义没有歧义：**它只是一个轮廓**。
 *
 *   注意源图并不是「纯白 + alpha」：实测它的不透明区是 255，但半透明边缘的 RGB 随 alpha
 *   一起变暗（如 alpha 23 → RGB 77）。也就是说它不是一张干净的 mask 源图，直接当 `<img>`
 *   用会在半透明边缘留下暗边。作为 mask 用时 RGB 被完全忽略（`mask-mode` 默认 `alpha`），
 *   所以不受影响——但这也是**不要把它当图片用**的另一个理由。
 *
 * 本脚本会校验的两条不变量（不满足就失败，不猜）：
 *   ① 源图是**单色**的（每像素 r == g == b）——否则它是彩色图标，不该走 mask 这条链路；
 *   ② alpha 里既有全透明也有全不透明像素——否则它是块实心方块，当 mask 会盖住整块区域。
 *
 * 产出：apps/desktop/src/renderer/src/assets/brand/dex-logo-mono.png（256² RGBA）
 * 用法：node scripts/gen-brand-assets.mjs   （已挂进 pnpm ds:build）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE = join(ROOT, 'brand/logo/dex-logo-mono-white-2048.png')
const TARGET = join(ROOT, 'apps/desktop/src/renderer/src/assets/brand/dex-logo-mono.png')
/** 输出边长。最大显示 44px，3x DPI 需 132px；256 留近 2 倍余量 */
const SIZE = 256

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ── CRC32（PNG 每个 chunk 都要）──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

// ── 解码 ────────────────────────────────────────────────────────────────────
/** 只支持 8-bit RGBA、非隔行——源图就是这个规格，遇到别的规格要显式失败而不是猜 */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG 文件')

  let offset = 8
  let header = null
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }

  if (header === null) throw new Error('缺少 IHDR')
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const interlace = header[12]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `只支持 8-bit RGBA 非隔行 PNG，源图是 bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    )
  }

  // PNG 逐行滤波：每行行首一个 filter 字节，再按类型做逆运算
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prior = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)

    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0
      const b = prior === null ? 0 : prior[x]
      const c = prior === null || x < 4 ? 0 : prior[x - 4]
      let value = src[x]
      switch (filter) {
        case 0:
          break
        case 1:
          value += a
          break
        case 2:
          value += b
          break
        case 3:
          value += (a + b) >> 1
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default:
          throw new Error(`未知的滤波类型 ${filter}（第 ${y} 行）`)
      }
      out[x] = value & 0xff
    }
  }

  return { width, height, pixels }
}

// ── 降采样 ──────────────────────────────────────────────────────────────────
/** 校验源图是单色轮廓：每像素 r == g == b，且 alpha 覆盖 0 与 255 */
function assertMonochromeShape({ pixels }) {
  let hasTransparent = false
  let hasOpaque = false

  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    if (r !== g || g !== b) {
      const px = i / 4
      throw new Error(
        `源图不是单色（首处不符在像素 ${px}：rgb(${r},${g},${b})）。` +
          '彩色标志不该走 CSS mask 这条链路——用 app-icon 变体，或改这条链路。',
      )
    }
    if (a === 0) hasTransparent = true
    if (a === 255) hasOpaque = true
  }

  if (!hasTransparent || !hasOpaque) {
    throw new Error('源图 alpha 不同时包含 0 与 255——它不是轮廓图，当 mask 会盖住整块区域。')
  }
}

/** box 滤波（区域平均）降采样 alpha 通道。CSS mask 只读 alpha，RGB 由本脚本统一写白 */
function downscaleAlpha({ width, height, pixels }, size) {
  const out = Buffer.alloc(size * size)
  const scaleX = width / size
  const scaleY = height / size

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.min(height, Math.floor((y + 1) * scaleY))
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.min(width, Math.floor((x + 1) * scaleX))
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += pixels[(sy * width + sx) * 4 + 3]
          count += 1
        }
      }
      out[y * size + x] = count === 0 ? 0 : Math.round(sum / count)
    }
  }

  return out
}

// ── 编码 ────────────────────────────────────────────────────────────────────
function encodePng(alpha, size) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    for (let x = 0; x < size; x++) {
      const i = y * (stride + 1) + 1 + x * 4
      raw[i] = 0xff
      raw[i + 1] = 0xff
      raw[i + 2] = 0xff
      raw[i + 3] = alpha[y * size + x]
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const sourceBytes = readFileSync(SOURCE)
const decoded = decodePng(sourceBytes)
assertMonochromeShape(decoded)
const alpha = downscaleAlpha(decoded, SIZE)
const output = encodePng(alpha, SIZE)
mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, output)

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
console.log(
  `[brand] ${decoded.width}² ${kb(sourceBytes.length)} → ${SIZE}² ${kb(output.length)}` +
    `  (省 ${(100 - (output.length / sourceBytes.length) * 100).toFixed(1)}%)`,
)
console.log(`[brand] -> ${TARGET}`)
