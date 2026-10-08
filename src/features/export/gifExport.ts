import { applyPalette, GIFEncoder, quantize } from 'gifenc'
import type { Trip } from '@/types'
import type { TripGeometry } from '@/lib/geo/tripGeometry'
import { OSM_ATTRIBUTION } from '@/features/map/mapConfig'
import { drawPlaneShape } from '@/features/map/routeLayers'
import { assertNotBlank, ellipsize, EXPORT_FONT as FONT, ExportError, renderExportMap, throwIfAborted, withTimeout } from './exportMap'
import { GIF_SIZES, markUnchangedTransparent, planGifFrames, projectLeg, screenPathUntil, screenPointAt, type GifSize } from './gifPlan'

export interface GifInput {
  trip: Trip
  geometry: TripGeometry
  size: GifSize
  withoutBasemap?: boolean
  signal?: AbortSignal
  onProgress?: (p: GifProgress) => void
}

export interface GifProgress {
  stage: 'map' | 'frames' | 'done'
  /** 0..1 */
  ratio: number
  frame?: number
  totalFrames?: number
}

export interface GifResult {
  blob: Blob
  frames: number
  width: number
  height: number
  durationMs: number
}

/** 让出主线程，保持界面响应并允许取消 */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

/** 最近调色板颜色（欧氏距离，带缓存），跳过透明索引 */
function nearestIndexer(palette: number[][], skip: number) {
  const cache = new Map<number, number>()
  return (r: number, g: number, b: number) => {
    const key = (r << 16) | (g << 8) | b
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < palette.length; k++) {
      if (k === skip) continue
      const c = palette[k]
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    cache.set(key, best)
    return best
  }
}

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

interface LegScreen {
  pts: [number, number][]
  cumulativeKm: number[]
  totalKm: number
  color: string
  number: number
  label: string
  date: string
}

function strokeRoute(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, width: number) {
  if (pts.length < 2) return
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = width + 3
  ctx.stroke()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

/**
 * 导出航线动画 GIF：
 * 1. 离屏地图渲染一次底图（所有航线淡色、机场标签），不影响主地图；
 * 2. 每帧在 2D 画布上叠加已飞航段、当前航段轨迹与飞机，以及标题和说明；
 * 3. 全局调色板 + 帧差透明压缩后编码。
 */
export async function renderRouteGif({ trip, geometry, size, withoutBasemap = false, signal, onProgress }: GifInput): Promise<GifResult> {
  if (geometry.legs.length === 0) throw new ExportError('当前假期还没有可绘制的航段')
  const { width: W, height: H } = GIF_SIZES[size]
  const scale = W / 640
  await withTimeout(document.fonts.ready.then(() => undefined), 5000, '字体加载超时').catch(() => undefined)
  throwIfAborted(signal)
  onProgress?.({ stage: 'map', ratio: 0 })

  // 1. 底图：所有航线以淡色显示（选中一个不存在的航段即全部「dim」）
  const exportMap = await renderExportMap(geometry, {
    width: W,
    height: H,
    padding: { top: Math.round(84 * scale), bottom: Math.round(40 * scale), left: Math.round(36 * scale), right: Math.round(36 * scale) },
    withoutBasemap,
    selectedLegId: '__gif-base__',
    label: 'GIF',
    signal,
  })
  let base: HTMLCanvasElement
  let legs: LegScreen[]
  let attribution: string
  try {
    base = document.createElement('canvas')
    base.width = W
    base.height = H
    const bctx = base.getContext('2d', { willReadFrequently: true })
    if (!bctx) throw new ExportError('浏览器无法创建画布')
    bctx.drawImage(exportMap.canvas, 0, 0, W, H)
    assertNotBlank(bctx, { x: 0, y: 0, w: W, h: H }, withoutBasemap)
    legs = geometry.legs.map((g) => ({
      pts: projectLeg(g.route.unwrapped, exportMap.project, { width: W, height: H }),
      cumulativeKm: g.route.cumulativeKm,
      totalKm: g.route.totalKm,
      color: g.color,
      number: g.number,
      label: `${g.from.iata} → ${g.to.iata}`,
      date: g.leg.departureDate,
    }))
    const extra = exportMap.attributions.filter((a) => !a.includes(OSM_ATTRIBUTION))
    attribution = withoutBasemap ? '无底图' : [OSM_ATTRIBUTION, ...extra].join(' · ')
  } finally {
    exportMap.cleanup()
  }
  throwIfAborted(signal)

  const frame = document.createElement('canvas')
  frame.width = W
  frame.height = H
  const ctx = frame.getContext('2d', { willReadFrequently: true })!

  // 静态层：底图 + 底部说明与署名（所有帧相同）
  const staticCanvas = document.createElement('canvas')
  staticCanvas.width = W
  staticCanvas.height = H
  const sctx = staticCanvas.getContext('2d', { willReadFrequently: true })!
  sctx.drawImage(base, 0, 0)
  {
    const barH = 22 * scale
    sctx.fillStyle = 'rgba(15,23,42,0.72)'
    sctx.fillRect(0, H - barH, W, barH)
    sctx.fillStyle = '#ffffff'
    sctx.font = `500 ${Math.round(11 * scale)}px ${FONT}`
    sctx.textBaseline = 'middle'
    sctx.fillText('示意航线 · 非实际飞行路径', 8 * scale, H - barH / 2)
    sctx.textAlign = 'right'
    sctx.fillText(ellipsize(sctx, attribution, W * 0.55), W - 8 * scale, H - barH / 2)
  }

  // 标题卡片：起始画面 + 每个航段各一张
  const makeCard = (cur: LegScreen | null) => {
    const pad = 12 * scale
    const measure = document.createElement('canvas').getContext('2d')!
    measure.font = `700 ${Math.round(18 * scale)}px ${FONT}`
    const title = ellipsize(measure, trip.title, W * 0.6)
    const titleW = measure.measureText(title).width
    const sub = cur ? `第 ${cur.number}/${legs.length} 段 · ${cur.label} · ${cur.date}` : `${legs.length} 段航程`
    measure.font = `500 ${Math.round(13 * scale)}px ${FONT}`
    const subW = measure.measureText(sub).width
    const accent = cur ? 6 * scale : 0
    const c = document.createElement('canvas')
    c.width = Math.ceil(Math.max(titleW, subW) + pad * 2 + accent)
    c.height = Math.ceil(54 * scale)
    const k = c.getContext('2d')!
    k.fillStyle = '#ffffff'
    k.beginPath()
    k.roundRect(0, 0, c.width, c.height, 10 * scale)
    k.fill()
    if (cur) {
      k.fillStyle = cur.color
      k.fillRect(0, 10 * scale, 4 * scale, c.height - 20 * scale)
    }
    k.fillStyle = '#0f172a'
    k.font = `700 ${Math.round(18 * scale)}px ${FONT}`
    k.fillText(title, pad + accent, 24 * scale)
    k.fillStyle = '#475569'
    k.font = `500 ${Math.round(13 * scale)}px ${FONT}`
    k.fillText(sub, pad + accent, 44 * scale)
    return c
  }
  const cards = [makeCard(null), ...legs.map((l) => makeCard(l))]

  const drawFrame = (legIndex: number, t: number) => {
    ctx.drawImage(staticCanvas, 0, 0)
    // 已完成航段
    for (let i = 0; i < legIndex; i++) strokeRoute(ctx, legs[i].pts, legs[i].color, 3 * scale)
    const cur = legIndex >= 0 ? legs[legIndex] : null
    if (cur) {
      const km = t * cur.totalKm
      strokeRoute(ctx, screenPathUntil(cur.pts, cur.cumulativeKm, km), cur.color, 3.5 * scale)
      const p = screenPointAt(cur.pts, cur.cumulativeKm, km)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.angle)
      ctx.scale(scale * 0.9, scale * 0.9)
      drawPlaneShape(ctx)
      ctx.restore()
    }

    // 标题卡片（预渲染，避免每帧重新排版文字）
    const card = cards[legIndex + 1]
    ctx.drawImage(card, 12 * scale, 12 * scale)
  }

  const frames = planGifFrames(legs.length)

  // 2. 全局调色板：由起始帧和终点帧（包含所有元素）共同量化，避免逐帧闪烁
  const staticPixels = sctx.getImageData(0, 0, W, H).data
  drawFrame(legs.length - 1, 1)
  const endPixels = ctx.getImageData(0, 0, W, H).data
  const sample = new Uint8ClampedArray(staticPixels.length + endPixels.length)
  sample.set(staticPixels, 0)
  sample.set(endPixels, staticPixels.length)
  // 航线、飞机、文字的精确颜色单独保留调色板槽位，避免细线被量化成相近的杂色
  const reserved = [...new Set([...legs.map((l) => l.color), '#ffffff', '#0f172a', '#475569'])].map(hexToRgb)
  const palette = quantize(sample, 255 - reserved.length)
  palette.push(...reserved)
  const transparentIndex = palette.length
  palette.push([255, 0, 255])

  // 静态层只做一次调色板映射；每帧只需映射与静态层不同的像素（航线、飞机、标题卡）
  const staticIndexed = applyPalette(staticPixels, palette.slice(0, transparentIndex))
  const nearest = nearestIndexer(palette, transparentIndex)
  const indexFrame = (rgba: Uint8ClampedArray) => {
    const out = staticIndexed.slice()
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      if (rgba[i] !== staticPixels[i] || rgba[i + 1] !== staticPixels[i + 1] || rgba[i + 2] !== staticPixels[i + 2]) {
        out[p] = nearest(rgba[i], rgba[i + 1], rgba[i + 2])
      }
    }
    return out
  }

  // 3. 逐帧绘制与编码
  const gif = GIFEncoder()
  let prev: Uint8Array | null = null
  let durationMs = 0
  for (let i = 0; i < frames.length; i++) {
    throwIfAborted(signal)
    const f = frames[i]
    drawFrame(f.legIndex, f.t)
    const indexed = indexFrame(ctx.getImageData(0, 0, W, H).data)
    if (prev === null) {
      gif.writeFrame(indexed, W, H, { palette, delay: f.delayMs, repeat: 0 })
    } else {
      gif.writeFrame(markUnchangedTransparent(prev, indexed, transparentIndex), W, H, {
        delay: f.delayMs,
        transparent: true,
        transparentIndex,
        dispose: 1,
      })
    }
    prev = indexed
    durationMs += f.delayMs
    onProgress?.({ stage: 'frames', ratio: (i + 1) / frames.length, frame: i + 1, totalFrames: frames.length })
    if (i % 4 === 3) await yieldToUi()
  }
  gif.finish()
  const blob = new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' })
  if (blob.size === 0) throw new ExportError('生成的 GIF 为空')
  onProgress?.({ stage: 'done', ratio: 1 })
  return { blob, frames: frames.length, width: W, height: H, durationMs }
}
