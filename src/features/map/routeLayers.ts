import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import type { FeatureCollection, LineString, Point } from 'geojson'
import type { LngLat } from '@/types'
import { airportsFeatureCollection, legLabelsFeatureCollection, routesFeatureCollection, type TripGeometry } from '@/lib/geo/tripGeometry'

export const SRC = {
  routes: 'hfm-routes',
  labels: 'hfm-leg-labels',
  airports: 'hfm-airports',
  trail: 'hfm-trail',
  plane: 'hfm-plane',
} as const

export const LAYER = {
  routeCasing: 'hfm-route-casing',
  route: 'hfm-route',
  routeHit: 'hfm-route-hit',
  trail: 'hfm-trail',
  airportDot: 'hfm-airport-dot',
  airportLabel: 'hfm-airport-label',
  legLabel: 'hfm-leg-label',
  plane: 'hfm-plane',
} as const

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const IMAGE_RATIO = 2
const FONT = '"Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'

/** 在画布上生成图标（机场标签、航段编号、飞机），放入 WebGL 图层，导出时可被捕获，无需字体服务 */
function makeImage(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width * IMAGE_RATIO
  canvas.height = height * IMAGE_RATIO
  const ctx = canvas.getContext('2d')!
  ctx.scale(IMAGE_RATIO, IMAGE_RATIO)
  draw(ctx)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function airportLabelImage(iata: string) {
  const w = 40
  const h = 20
  return makeImage(w, h, (ctx) => {
    roundRect(ctx, 1, 1, w - 2, h - 2, 6)
    ctx.fillStyle = 'rgba(15,23,42,0.88)'
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `600 12px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(iata, w / 2, h / 2 + 0.5)
  })
}

function legBadgeImage(num: string, color: string) {
  const size = 22
  return makeImage(size, size, (ctx) => {
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${num.length > 1 ? 10 : 12}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(num, size / 2, size / 2 + 0.5)
  })
}

/** 在当前坐标原点绘制机头朝上（正北）的飞机轮廓，长约 28px；GIF 导出也复用 */
export function drawPlaneShape(ctx: CanvasRenderingContext2D) {
  ctx.beginPath()
  ctx.moveTo(0, -14)
  ctx.quadraticCurveTo(2.2, -12, 2.2, -8)
  ctx.lineTo(2.2, -3)
  ctx.lineTo(13, 4)
  ctx.lineTo(13, 7)
  ctx.lineTo(2.2, 3.5)
  ctx.lineTo(2, 9)
  ctx.lineTo(5.5, 12)
  ctx.lineTo(5.5, 14)
  ctx.lineTo(0, 12.5)
  ctx.lineTo(-5.5, 14)
  ctx.lineTo(-5.5, 12)
  ctx.lineTo(-2, 9)
  ctx.lineTo(-2.2, 3.5)
  ctx.lineTo(-13, 7)
  ctx.lineTo(-13, 4)
  ctx.lineTo(-2.2, -3)
  ctx.lineTo(-2.2, -8)
  ctx.quadraticCurveTo(-2.2, -12, 0, -14)
  ctx.closePath()
  ctx.fillStyle = '#0f172a'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.stroke()
  ctx.fill()
}

/** 机头朝上（正北）的飞机图标，旋转由 icon-rotate 控制 */
function planeImage() {
  const s = 32
  return makeImage(s, s, (ctx) => {
    ctx.translate(s / 2, s / 2)
    drawPlaneShape(ctx)
  })
}

/** 按需生成缺失图标（MapLibre v6 的 missing style image resolver） */
function imageResolver(map: MlMap) {
  return (id: string) => {
    if (map.hasImage(id)) return
    if (id.startsWith('apt:')) map.addImage(id, airportLabelImage(id.slice(4)), { pixelRatio: IMAGE_RATIO })
    else if (id.startsWith('leg:')) {
      const [, num, color] = id.split(':')
      map.addImage(id, legBadgeImage(num, color), { pixelRatio: IMAGE_RATIO })
    } else if (id === 'plane') map.addImage(id, planeImage(), { pixelRatio: IMAGE_RATIO })
  }
}

export interface RouteLayerOptions {
  /** 主地图包含播放图层与点击热区；海报导出不需要 */
  interactive: boolean
}

/** 添加航线相关数据源与图层（主地图与导出地图共用，保证一致） */
export function addRouteLayers(map: MlMap, { interactive }: RouteLayerOptions): () => void {
  map.setMissingStyleImageResolver(imageResolver(map))

  map.addSource(SRC.routes, { type: 'geojson', data: EMPTY })
  map.addSource(SRC.labels, { type: 'geojson', data: EMPTY })
  map.addSource(SRC.airports, { type: 'geojson', data: EMPTY })

  map.addLayer({
    id: LAYER.routeCasing,
    type: 'line',
    source: SRC.routes,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['match', ['get', 'emphasis'], 'selected', 9, 5.5],
      'line-opacity': ['match', ['get', 'emphasis'], 'dim', 0.4, 0.9],
    },
  })
  map.addLayer({
    id: LAYER.route,
    type: 'line',
    source: SRC.routes,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['match', ['get', 'emphasis'], 'selected', 5, 2.75],
      'line-opacity': ['match', ['get', 'emphasis'], 'dim', 0.35, 0.95],
    },
  })

  if (interactive) {
    map.addLayer({
      id: LAYER.routeHit,
      type: 'line',
      source: SRC.routes,
      paint: { 'line-color': '#000000', 'line-width': 16, 'line-opacity': 0 },
    })
    map.addSource(SRC.trail, { type: 'geojson', data: EMPTY })
    map.addLayer({
      id: LAYER.trail,
      type: 'line',
      source: SRC.trail,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 1 },
    })
  }

  map.addLayer({
    id: LAYER.airportDot,
    type: 'circle',
    source: SRC.airports,
    paint: { 'circle-radius': 5, 'circle-color': '#0f172a', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  })
  map.addLayer({
    id: LAYER.legLabel,
    type: 'symbol',
    source: SRC.labels,
    layout: {
      'icon-image': ['concat', 'leg:', ['get', 'number'], ':', ['get', 'color']],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['to-number', ['get', 'number']],
    },
    paint: { 'icon-opacity': ['match', ['get', 'emphasis'], 'dim', 0.55, 1] },
  })
  map.addLayer({
    id: LAYER.airportLabel,
    type: 'symbol',
    source: SRC.airports,
    layout: {
      'icon-image': ['concat', 'apt:', ['get', 'iata']],
      'icon-anchor': 'bottom',
      'icon-offset': [0, -7],
      'icon-allow-overlap': true,
    },
  })

  if (interactive) {
    map.addSource(SRC.plane, { type: 'geojson', data: EMPTY })
    map.addLayer({
      id: LAYER.plane,
      type: 'symbol',
      source: SRC.plane,
      layout: {
        'icon-image': 'plane',
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
  }

  return () => {
    map.setMissingStyleImageResolver(null)
  }
}

export function setRouteData(map: MlMap, geo: TripGeometry, selectedLegId: string | null) {
  const routes = routesFeatureCollection(geo, selectedLegId)
  const labels = legLabelsFeatureCollection(geo, selectedLegId)
  ;(map.getSource(SRC.routes) as GeoJSONSource | undefined)?.setData(routes)
  ;(map.getSource(SRC.labels) as GeoJSONSource | undefined)?.setData(labels)
  ;(map.getSource(SRC.airports) as GeoJSONSource | undefined)?.setData(airportsFeatureCollection(geo))
}

export interface PlaneState {
  position: LngLat
  bearing: number
  trail: LngLat[]
  color: string
}

export function setPlane(map: MlMap, plane: PlaneState | null) {
  const planeData: FeatureCollection<Point> = plane
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { bearing: plane.bearing }, geometry: { type: 'Point', coordinates: plane.position } }] }
    : { type: 'FeatureCollection', features: [] }
  const trailData: FeatureCollection<LineString> =
    plane && plane.trail.length >= 2
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color: plane.color }, geometry: { type: 'LineString', coordinates: plane.trail } }] }
      : { type: 'FeatureCollection', features: [] }
  ;(map.getSource(SRC.plane) as GeoJSONSource | undefined)?.setData(planeData)
  ;(map.getSource(SRC.trail) as GeoJSONSource | undefined)?.setData(trailData)
}
