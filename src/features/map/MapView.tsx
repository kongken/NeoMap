import { useEffect, useRef, useState } from 'react'
import { Map as MlMap, NavigationControl, type ErrorEvent, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './maplibreSetup'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TripGeometry } from '@/lib/geo/tripGeometry'
import type { Bounds } from '@/lib/geo/greatCircle'
import { isWebglAvailable, mapStyleFor, readMapConfig } from './mapConfig'
import { addRouteLayers, LAYER, setPlane, setRouteData, type PlaneState } from './routeLayers'

export interface FitPadding {
  top: number
  bottom: number
  left: number
  right: number
}

interface Props {
  geometry: TripGeometry
  selectedLegId: string | null
  onSelectLeg: (legId: string | null) => void
  plane: PlaneState | null
  /** 递增时适配视野；无航线时保持挂起，直到有可适配的范围 */
  fitRequest: number
  padding: FitPadding
}

type LoadState = 'loading' | 'ready' | 'error' | 'unsupported'

const WORLD_VIEW = { center: [110, 25] as [number, number], zoom: 1.3 }

function fitTo(map: MlMap, bounds: Bounds, padding: FitPadding, animate: boolean) {
  const container = map.getContainer()
  const w = container.clientWidth
  const h = container.clientHeight
  if (w === 0 || h === 0) return false
  // 预留空间不得超过画布，避免 fitBounds 失败
  const pad = {
    top: Math.min(padding.top, h * 0.4),
    bottom: Math.min(padding.bottom, h * 0.4),
    left: Math.min(padding.left, w * 0.4),
    right: Math.min(padding.right, w * 0.4),
  }
  const span = Math.max(bounds.east - bounds.west, bounds.north - bounds.south)
  map.fitBounds(
    [
      [bounds.west, Math.max(-85, bounds.south)],
      [bounds.east, Math.min(85, bounds.north)],
    ],
    { padding: pad, maxZoom: span < 1 ? 8 : 6, animate, duration: animate ? 800 : 0 },
  )
  return true
}

export function MapView({ geometry, selectedLegId, onSelectLeg, plane, fitRequest, padding }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [state, setState] = useState<LoadState>(() => (isWebglAvailable() ? 'loading' : 'unsupported'))
  const [basemapError, setBasemapError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [layersReady, setLayersReady] = useState(false)

  // 最新值引用，供地图事件回调使用
  const onSelectRef = useRef(onSelectLeg)
  useEffect(() => {
    onSelectRef.current = onSelectLeg
  }, [onSelectLeg])
  const handledFit = useRef(-1)
  const worldShownFor = useRef(-1)

  // 创建地图（StrictMode 下 effect 会运行两次：清理函数会移除前一个实例）
  useEffect(() => {
    if (!isWebglAvailable()) {
      setState('unsupported')
      return
    }
    const container = containerRef.current
    if (!container) return
    setState('loading')
    setBasemapError(false)
    setLayersReady(false)
    handledFit.current = -1
    worldShownFor.current = -1

    let map: MlMap
    try {
      map = new MlMap({
        container,
        style: mapStyleFor(readMapConfig()),
        center: WORLD_VIEW.center,
        zoom: WORLD_VIEW.zoom,
        attributionControl: { compact: false },
        renderWorldCopies: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      })
    } catch {
      setState('unsupported')
      return
    }
    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')

    let tileErrors = 0
    let removeLayers: (() => void) | null = null

    const onLoad = () => {
      loaded = true
      removeLayers = addRouteLayers(map, { interactive: true })
      setLayersReady(true)
      setState('ready')
    }
    let loaded = false
    const onError = (e: ErrorEvent & { sourceId?: string }) => {
      if (e.sourceId?.startsWith('hfm-')) return
      if (e.sourceId) {
        // 底图瓦片失败：累计若干次后提示，可重试
        tileErrors++
        if (tileErrors >= 3) setBasemapError(true)
      } else if (!loaded) {
        // 样式或引擎在加载阶段失败
        setState('error')
      }
    }
    const onClick = (e: MapMouseEvent) => {
      if (!map.getLayer(LAYER.routeHit)) return
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER.routeHit, LAYER.legLabel] })
      const legId = features[0]?.properties?.legId as string | undefined
      onSelectRef.current(legId ?? null)
    }
    const setCursor = (c: string) => () => {
      map.getCanvas().style.cursor = c
    }
    const enter = setCursor('pointer')
    const leave = setCursor('')

    map.on('load', onLoad)
    map.on('error', onError)
    map.on('click', onClick)
    map.on('mouseenter', LAYER.routeHit, enter)
    map.on('mouseleave', LAYER.routeHit, leave)

    const ro = new ResizeObserver(() => map.resize())
    ro.observe(container)

    return () => {
      ro.disconnect()
      map.off('load', onLoad)
      map.off('error', onError)
      map.off('click', onClick)
      map.off('mouseenter', LAYER.routeHit, enter)
      map.off('mouseleave', LAYER.routeHit, leave)
      removeLayers?.()
      map.remove()
      mapRef.current = null
    }
  }, [attempt])

  // 数据更新
  useEffect(() => {
    const map = mapRef.current
    if (!map || !layersReady) return
    setRouteData(map, geometry, selectedLegId)
  }, [geometry, selectedLegId, layersReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !layersReady) return
    setPlane(map, plane)
  }, [plane, layersReady])

  // 视野适配：仅在请求序号变化时执行；没有范围时挂起
  const bounds = geometry.bounds
  const paddingRef = useRef(padding)
  useEffect(() => {
    paddingRef.current = padding
  }, [padding])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !layersReady || handledFit.current === fitRequest) return
    if (!bounds) {
      // 空行程：回到世界视图，并保持挂起，首个航段加入后再适配
      if (worldShownFor.current !== fitRequest) {
        worldShownFor.current = fitRequest
        map.jumpTo(WORLD_VIEW)
      }
      return
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (fitTo(map, bounds, paddingRef.current, handledFit.current !== -1 && !reduceMotion)) handledFit.current = fitRequest
  }, [fitRequest, bounds, layersReady])

  if (state === 'unsupported') {
    return (
      <div className="flex h-full items-center justify-center bg-muted/50 p-6 text-center" role="status">
        <div className="max-w-sm space-y-2">
          <AlertTriangle className="mx-auto size-8 text-amber-500" aria-hidden />
          <p className="font-medium">此浏览器无法显示地图</p>
          <p className="text-sm text-muted-foreground">未检测到 WebGL2 支持（可能被禁用或硬件加速已关闭）。你仍然可以管理航段、查看统计并导出备份。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" aria-label="航线地图" role="region" />
      {state === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/40" role="status">
          <span className="flex items-center gap-2 rounded-full bg-background px-3 py-1.5 text-sm shadow">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            地图加载中…
          </span>
        </div>
      )}
      {(state === 'error' || basemapError) && (
        <div className="absolute inset-x-3 top-3 z-10 mx-auto flex max-w-md items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="flex-1">
            <p className="font-medium">{state === 'error' ? '地图加载失败' : '底图加载失败'}</p>
            <p className="text-amber-800">请检查网络连接后重试。行程列表和统计不受影响。</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw aria-hidden />
            重试
          </Button>
        </div>
      )}
    </div>
  )
}
