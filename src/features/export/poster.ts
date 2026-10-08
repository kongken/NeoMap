import { Map as MlMap, type ErrorEvent } from 'maplibre-gl'
import type { Trip } from '@/types'
import type { TripGeometry, TripStats } from '@/lib/geo/tripGeometry'
import { blankStyle, mapStyleFor, OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, readMapConfig, stripHtml } from '@/features/map/mapConfig'
import { addRouteLayers, setRouteData } from '@/features/map/routeLayers'
import '@/features/map/maplibreSetup'

export const POSTER_WIDTH = 1600
export const POSTER_HEIGHT = 1000
const MAP_BOX = { x: 40, y: 150, w: 1520, h: 680 }
const EXPORT_TIMEOUT_MS = 25000
const FONT = '"Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'

export class PosterExportError extends Error {
  /** 底图相关失败：可以提供「无底图」回退 */
  readonly basemapFailure: boolean
  constructor(message: string, basemapFailure = false) {
    super(message)
    this.basemapFailure = basemapFailure
  }
}

export interface PosterInput {
  trip: Trip
  geometry: TripGeometry
  stats: TripStats
  /** true：用户主动选择「无底图」海报 */
  withoutBasemap?: boolean
}

/** 合法化文件名：去掉非法字符与控制字符，限制长度 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|]/g, '-')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.slice(0, 80) || 'trip'
}

export function posterFileName(trip: Trip, now = new Date()): string {
  const month = (trip.startDate ?? now.toISOString().slice(0, 10)).slice(0, 7)
  return `holiday-flight-map-${sanitizeFileName(trip.title)}-${month}.png`
}

export function formatDateRange(trip: Pick<Trip, 'startDate' | 'endDate'>): string {
  if (trip.startDate && trip.endDate) return `${trip.startDate} — ${trip.endDate}`
  return trip.startDate ?? trip.endDate ?? ''
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PosterExportError(message, true)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** 轮询直到条件成立；条件抛错则立即失败 */
function waitUntil(check: () => boolean, ms: number, timeoutMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const tick = () => {
      try {
        if (check()) return resolve()
      } catch (err) {
        return reject(err)
      }
      if (performance.now() - started > ms) return reject(new PosterExportError(timeoutMessage, true))
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 用独立的离屏地图渲染整段行程，不影响主地图视角和播放进度 */
async function renderExportMap(geometry: TripGeometry, withoutBasemap: boolean): Promise<{ canvas: HTMLCanvasElement; attributions: string[]; cleanup: () => void }> {
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${MAP_BOX.w}px`,
    height: `${MAP_BOX.h}px`,
    pointerEvents: 'none',
  })
  document.body.appendChild(container)

  const config = readMapConfig()
  let map: MlMap | null = null
  const cleanup = () => {
    map?.remove()
    map = null
    container.remove()
  }

  try {
    const bounds = geometry.bounds
    map = new MlMap({
      container,
      style: withoutBasemap ? blankStyle() : mapStyleFor(config),
      interactive: false,
      attributionControl: false,
      // 按 MapLibre v6 MapOptions：读取画布像素需要保留绘图缓冲
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
      pixelRatio: 1,
      fadeDuration: 0,
      renderWorldCopies: true,
      ...(bounds
        ? {
            bounds: [
              [bounds.west, Math.max(-85, bounds.south)],
              [bounds.east, Math.min(85, bounds.north)],
            ] as [[number, number], [number, number]],
            fitBoundsOptions: { padding: 70, maxZoom: 6 },
          }
        : { center: [110, 25] as [number, number], zoom: 1.5 }),
    })
    const m = map

    // 瓦片错误带 sourceId；没有 sourceId 的错误视为样式 / 引擎错误
    let basemapErrors = 0
    let styleError: string | null = null
    m.on('error', (e: ErrorEvent & { sourceId?: string }) => {
      if (e.sourceId?.startsWith('hfm-')) return
      if (e.sourceId) basemapErrors++
      else styleError = e.error?.message ?? '未知错误'
    })

    let loaded = false
    m.once('load', () => {
      loaded = true
    })
    await waitUntil(
      () => {
        if (styleError) throw new PosterExportError(`地图加载失败：${styleError}`, true)
        return loaded
      },
      EXPORT_TIMEOUT_MS,
      '地图加载超时',
    )

    addRouteLayers(m, { interactive: false })
    setRouteData(m, geometry, null)

    // 等待所有瓦片与图标请求结束（成功或失败）
    m.triggerRepaint()
    await waitUntil(() => {
      if (styleError) throw new PosterExportError(`地图渲染失败：${styleError}`, true)
      return m.loaded() && m.areTilesLoaded()
    }, EXPORT_TIMEOUT_MS, '底图瓦片加载超时')
    // 再渲染一帧，确保画布包含最新内容
    await withTimeout(
      new Promise<void>((resolve) => {
        m.once('render', () => resolve())
        m.triggerRepaint()
      }),
      5000,
      '地图渲染超时',
    )

    if (!withoutBasemap && basemapErrors > 0) {
      throw new PosterExportError(`底图加载失败（${basemapErrors} 个瓦片无法获取），为避免生成不完整的海报已停止导出`, true)
    }

    // 收集各数据源的署名
    const attributions = new Set<string>()
    for (const id of Object.keys(m.getStyle().sources)) {
      const src = m.getSource(id) as { attribution?: string } | undefined
      if (src?.attribution) attributions.add(stripHtml(src.attribution))
    }
    if (config.kind === 'style' && config.extraAttribution) attributions.add(config.extraAttribution)

    return { canvas: m.getCanvas(), attributions: [...attributions], cleanup }
  } catch (err) {
    cleanup()
    throw err
  }
}

/** 检查地图画面不是纯色（黑图 / 空图） */
function assertNotBlank(ctx: CanvasRenderingContext2D, withoutBasemap: boolean) {
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h).data
  } catch {
    throw new PosterExportError('地图图像受跨域限制，无法导出（请检查瓦片服务的 CORS 设置）', true)
  }
  const colors = new Set<number>()
  const step = 4 * 997
  for (let i = 0; i < data.length && colors.size < 50; i += step) {
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
  }
  if (colors.size < (withoutBasemap ? 2 : 8)) throw new PosterExportError('地图画面为空，可能是底图尚未加载', !withoutBasemap)
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1)
  return `${t}…`
}

export async function renderPoster({ trip, geometry, stats, withoutBasemap = false }: PosterInput): Promise<Blob> {
  if (geometry.legs.length === 0) throw new PosterExportError('当前假期还没有可绘制的航段')
  await withTimeout(document.fonts.ready.then(() => undefined), 5000, '字体加载超时').catch(() => undefined)

  const { canvas: mapCanvas, attributions, cleanup } = await renderExportMap(geometry, withoutBasemap)
  try {
    const poster = document.createElement('canvas')
    poster.width = POSTER_WIDTH
    poster.height = POSTER_HEIGHT
    const ctx = poster.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new PosterExportError('浏览器无法创建画布')

    // 背景
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)
    ctx.fillStyle = '#2563eb'
    ctx.fillRect(0, 0, POSTER_WIDTH, 8)

    // 标题
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#0f172a'
    ctx.font = `700 50px ${FONT}`
    ctx.fillText(ellipsize(ctx, trip.title, 1100), 40, 84)
    const range = formatDateRange(trip)
    ctx.fillStyle = '#475569'
    ctx.font = `400 24px ${FONT}`
    ctx.fillText(range || '　', 40, 126)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#2563eb'
    ctx.font = `600 22px ${FONT}`
    ctx.fillText('Holiday Flight Map · 假日飞行航线图', POSTER_WIDTH - 40, 84)
    ctx.textAlign = 'left'

    // 地图
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h, 18)
    ctx.clip()
    ctx.drawImage(mapCanvas, MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h)
    ctx.restore()
    assertNotBlank(ctx, withoutBasemap)
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h, 18)
    ctx.stroke()

    if (withoutBasemap) {
      ctx.fillStyle = 'rgba(15,23,42,0.75)'
      ctx.beginPath()
      ctx.roundRect(MAP_BOX.x + 16, MAP_BOX.y + 16, 120, 36, 8)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `600 18px ${FONT}`
      ctx.fillText('无底图', MAP_BOX.x + 46, MAP_BOX.y + 41)
    }

    // 统计
    const statItems: [string, string][] = [
      ['航段', String(stats.legCount)],
      ['机场', String(stats.airportCount)],
      ['到达城市', String(stats.cityCount)],
      ['估算飞行距离', `${stats.totalKm.toLocaleString('zh-CN')} km`],
    ]
    const statY = MAP_BOX.y + MAP_BOX.h + 62
    statItems.forEach(([label, value], i) => {
      const x = 40 + i * 260
      ctx.fillStyle = '#0f172a'
      ctx.font = `700 40px ${FONT}`
      ctx.fillText(value, x, statY)
      ctx.fillStyle = '#64748b'
      ctx.font = `400 20px ${FONT}`
      ctx.fillText(label, x, statY + 32)
    })

    // 说明（右侧）
    ctx.textAlign = 'right'
    ctx.fillStyle = '#334155'
    ctx.font = `600 20px ${FONT}`
    ctx.fillText('示意航线 · 距离为估算', POSTER_WIDTH - 40, statY - 10)
    ctx.fillStyle = '#64748b'
    ctx.font = `400 16px ${FONT}`
    ctx.fillText('不代表实际飞行路径', POSTER_WIDTH - 40, statY + 22)
    ctx.textAlign = 'left'

    // 署名（底部整行）：保留所有底图来源署名
    const extra = attributions.filter((a) => !a.includes(OSM_ATTRIBUTION))
    const credit = withoutBasemap
      ? '无底图海报（未包含地图底图） · 机场坐标：OurAirports'
      : [`底图 ${OSM_ATTRIBUTION} ${OSM_COPYRIGHT_URL}`, ...extra, '机场坐标：OurAirports'].join(' · ')
    ctx.fillStyle = '#64748b'
    ctx.font = `400 15px ${FONT}`
    ctx.fillText(ellipsize(ctx, credit, POSTER_WIDTH - 80), 40, POSTER_HEIGHT - 22)

    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        poster.toBlob(resolve, 'image/png')
      } catch (e) {
        reject(new PosterExportError(`无法生成图片：${(e as Error).message}`, true))
      }
    })
    if (!blob || blob.size === 0) throw new PosterExportError('生成的图片为空')
    return blob
  } finally {
    cleanup()
  }
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
