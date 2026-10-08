import { Map as MlMap, type ErrorEvent } from 'maplibre-gl'
import type { Trip } from '@/types'
import type { TripGeometry } from '@/lib/geo/tripGeometry'
import { blankStyle, mapStyleFor, readMapConfig, stripHtml } from '@/features/map/mapConfig'
import { addRouteLayers, setRouteData } from '@/features/map/routeLayers'
import '@/features/map/maplibreSetup'

/** 海报与 GIF 导出共用的工具：离屏地图、超时、文件名、文字排版 */

export const EXPORT_FONT = '"Geist Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
const EXPORT_TIMEOUT_MS = 25000

export class ExportError extends Error {
  /** 底图相关失败：可以提供「无底图」回退 */
  readonly basemapFailure: boolean
  constructor(message: string, basemapFailure = false) {
    super(message)
    this.basemapFailure = basemapFailure
  }
}

/** 用户取消导出 */
export class ExportAbortedError extends Error {
  constructor() {
    super('已取消导出')
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ExportAbortedError()
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

export function exportFileName(trip: Trip, ext: 'png' | 'gif', suffix = '', now = new Date()): string {
  const month = (trip.startDate ?? now.toISOString().slice(0, 10)).slice(0, 7)
  return `holiday-flight-map-${sanitizeFileName(trip.title)}-${month}${suffix}.${ext}`
}

export function formatDateRange(trip: Pick<Trip, 'startDate' | 'endDate'>): string {
  if (trip.startDate && trip.endDate) return `${trip.startDate} — ${trip.endDate}`
  return trip.startDate ?? trip.endDate ?? ''
}

export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1)
  return `${t}…`
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ExportError(message, true)), ms)
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
function waitUntil(check: () => boolean, ms: number, timeoutMessage: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const tick = () => {
      try {
        throwIfAborted(signal)
        if (check()) return resolve()
      } catch (err) {
        return reject(err)
      }
      if (performance.now() - started > ms) return reject(new ExportError(timeoutMessage, true))
      setTimeout(tick, 100)
    }
    tick()
  })
}

/** 检查地图画面不是纯色（黑图 / 空图）；也能发现跨域污染的画布 */
export function assertNotBlank(ctx: CanvasRenderingContext2D, box: { x: number; y: number; w: number; h: number }, withoutBasemap: boolean) {
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(box.x, box.y, box.w, box.h).data
  } catch {
    throw new ExportError('地图图像受跨域限制，无法导出（请检查瓦片服务的 CORS 设置）', true)
  }
  const colors = new Set<number>()
  const step = 4 * 997
  for (let i = 0; i < data.length && colors.size < 50; i += step) {
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2])
  }
  if (colors.size < (withoutBasemap ? 2 : 8)) throw new ExportError('地图画面为空，可能是底图尚未加载', !withoutBasemap)
}

export interface ExportMapOptions {
  width: number
  height: number
  padding: number | { top: number; bottom: number; left: number; right: number }
  withoutBasemap: boolean
  /** 传入一个不存在的 id 可让所有航线以淡色显示（GIF 底图） */
  selectedLegId?: string | null
  /** 文案中的导出物名称，例如「海报」「GIF」 */
  label: string
  signal?: AbortSignal
}

export interface ExportMap {
  canvas: HTMLCanvasElement
  attributions: string[]
  /** 地理坐标 → 画布像素（不做经度回绕，配合 alignLegToView 使用） */
  project: (lngLat: [number, number]) => [number, number]
  cleanup: () => void
}

/** 用独立的离屏地图渲染整段行程，不影响主地图视角和播放进度 */
export async function renderExportMap(geometry: TripGeometry, opts: ExportMapOptions): Promise<ExportMap> {
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${opts.width}px`,
    height: `${opts.height}px`,
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
      style: opts.withoutBasemap ? blankStyle() : mapStyleFor(config),
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
            fitBoundsOptions: { padding: opts.padding, maxZoom: 6 },
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
        if (styleError) throw new ExportError(`地图加载失败：${styleError}`, true)
        return loaded
      },
      EXPORT_TIMEOUT_MS,
      '地图加载超时',
      opts.signal,
    )

    addRouteLayers(m, { interactive: false })
    setRouteData(m, geometry, opts.selectedLegId ?? null)

    // 等待所有瓦片与图标请求结束（成功或失败）
    m.triggerRepaint()
    await waitUntil(
      () => {
        if (styleError) throw new ExportError(`地图渲染失败：${styleError}`, true)
        return m.loaded() && m.areTilesLoaded()
      },
      EXPORT_TIMEOUT_MS,
      '底图瓦片加载超时',
      opts.signal,
    )
    // 再渲染一帧，确保画布包含最新内容
    await withTimeout(
      new Promise<void>((resolve) => {
        m.once('render', () => resolve())
        m.triggerRepaint()
      }),
      5000,
      '地图渲染超时',
    )

    if (!opts.withoutBasemap && basemapErrors > 0) {
      throw new ExportError(`底图加载失败（${basemapErrors} 个瓦片无法获取），为避免生成不完整的${opts.label}已停止导出`, true)
    }

    // 收集各数据源的署名
    const attributions = new Set<string>()
    for (const id of Object.keys(m.getStyle().sources)) {
      const src = m.getSource(id) as { attribution?: string } | undefined
      if (src?.attribution) attributions.add(stripHtml(src.attribution))
    }
    if (config.kind === 'style' && config.extraAttribution) attributions.add(config.extraAttribution)

    const project = (p: [number, number]): [number, number] => {
      const pt = m.project(p)
      return [pt.x, pt.y]
    }
    return { canvas: m.getCanvas(), attributions: [...attributions], project, cleanup }
  } catch (err) {
    cleanup()
    throw err
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b && b.size > 0 ? resolve(b) : reject(new ExportError('生成的图片为空'))), type)
    } catch (e) {
      reject(new ExportError(`无法生成图片：${(e as Error).message}`, true))
    }
  })
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
