import type { FeatureCollection, LineString, Point } from 'geojson'
import type { Airport, FlightLeg, LngLat } from '@/types'
import { boundsOf, distanceKm, greatCircleRoute, pointAtDistance, type Bounds, type GreatCircleRoute } from './greatCircle'

/** 航段配色（按 order 循环），色盲友好度较好的高饱和色 */
export const ROUTE_COLORS = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5']

export function legColor(order: number): string {
  const i = ((Math.trunc(order) % ROUTE_COLORS.length) + ROUTE_COLORS.length) % ROUTE_COLORS.length
  return ROUTE_COLORS[i]
}

export const coordOf = (a: Pick<Airport, 'longitude' | 'latitude'>): LngLat => [a.longitude, a.latitude]

export interface LegGeometry {
  leg: FlightLeg
  from: Airport
  to: Airport
  route: GreatCircleRoute
  color: string
  /** 1 起的显示编号 */
  number: number
}

export interface TripGeometry {
  legs: LegGeometry[]
  /** 无法计算的航段（例如缺少机场快照） */
  invalidLegIds: string[]
  /** 使用退化路径的航段（近对跖/近重合） */
  warnings: { legId: string; warning: NonNullable<GreatCircleRoute['warning']> }[]
  airports: Airport[]
  bounds: Bounds | null
}

export function sortLegs(legs: FlightLeg[]): FlightLeg[] {
  return [...legs].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
}

export function buildTripGeometry(legs: FlightLeg[], airportsById: Map<string, Airport>): TripGeometry {
  const sorted = sortLegs(legs)
  const out: LegGeometry[] = []
  const invalidLegIds: string[] = []
  const warnings: TripGeometry['warnings'] = []
  const usedAirports = new Map<string, Airport>()

  sorted.forEach((leg, index) => {
    const from = airportsById.get(leg.departureAirportId)
    const to = airportsById.get(leg.arrivalAirportId)
    if (!from || !to) {
      invalidLegIds.push(leg.id)
      return
    }
    try {
      const route = greatCircleRoute(coordOf(from), coordOf(to))
      if (!route.unwrapped.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) throw new Error('non-finite')
      if (route.warning) warnings.push({ legId: leg.id, warning: route.warning })
      // 以 IATA 去重：共享机场只画一个标记
      if (!usedAirports.has(from.iata)) usedAirports.set(from.iata, from)
      if (!usedAirports.has(to.iata)) usedAirports.set(to.iata, to)
      out.push({ leg, from, to, route, color: legColor(index), number: index + 1 })
    } catch {
      invalidLegIds.push(leg.id)
    }
  })

  const allPoints: LngLat[] = []
  for (const g of out) allPoints.push(...g.route.unwrapped)
  for (const a of usedAirports.values()) allPoints.push(coordOf(a))

  return { legs: out, invalidLegIds, warnings, airports: [...usedAirports.values()], bounds: boundsOf(allPoints) }
}

export type Emphasis = 'selected' | 'normal' | 'dim'

const emphasisOf = (legId: string, selectedLegId: string | null): Emphasis =>
  selectedLegId === null ? 'normal' : legId === selectedLegId ? 'selected' : 'dim'

/** 航线 GeoJSON（展开经度的 LineString，MapLibre 会在相邻世界副本中连续绘制） */
export function routesFeatureCollection(geo: TripGeometry, selectedLegId: string | null): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: [...geo.legs].sort((a, b) => Number(a.leg.id === selectedLegId) - Number(b.leg.id === selectedLegId)).map((g) => ({
      type: 'Feature',
      id: g.number,
      properties: { legId: g.leg.id, color: g.color, number: g.number, emphasis: emphasisOf(g.leg.id, selectedLegId) },
      geometry: { type: 'LineString', coordinates: g.route.unwrapped },
    })),
  }
}

/** 航段编号标记，放在路线中点（距离意义上） */
export function legLabelsFeatureCollection(geo: TripGeometry, selectedLegId: string | null): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: geo.legs.map((g) => ({
      type: 'Feature',
      properties: { legId: g.leg.id, color: g.color, number: String(g.number), emphasis: emphasisOf(g.leg.id, selectedLegId) },
      geometry: { type: 'Point', coordinates: pointAtDistance(g.route, g.route.totalKm / 2).position },
    })),
  }
}

/** 机场点：共享机场只出现一次 */
export function airportsFeatureCollection(geo: TripGeometry): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: geo.airports.map((a) => ({
      type: 'Feature',
      properties: { airportId: a.id, iata: a.iata },
      geometry: { type: 'Point', coordinates: coordOf(a) },
    })),
  }
}

export interface TripStats {
  legCount: number
  airportCount: number
  cityCount: number
  totalKm: number
}

/** 城市去重键：城市名 + 国家/地区代码；无城市字段时退回机场 IATA */
export function cityKey(a: Airport): string {
  const city = (a.city ?? '').trim().toLowerCase()
  return city ? `${city}|${a.countryCode.toUpperCase()}` : `airport|${a.iata}`
}

export function computeStats(legs: FlightLeg[], airportsById: Map<string, Airport>): TripStats {
  const airportIatas = new Set<string>()
  const cities = new Set<string>()
  let km = 0
  for (const leg of legs) {
    const from = airportsById.get(leg.departureAirportId)
    const to = airportsById.get(leg.arrivalAirportId)
    if (from) airportIatas.add(from.iata)
    if (to) {
      airportIatas.add(to.iata)
      cities.add(cityKey(to))
    }
    if (from && to) km += distanceKm(coordOf(from), coordOf(to))
  }
  return { legCount: legs.length, airportCount: airportIatas.size, cityCount: cities.size, totalKm: Math.round(km) }
}

/** 相邻航段不连续（上一段到达 ≠ 下一段出发）的航段 id 集合 */
export function discontinuousLegIds(legs: FlightLeg[], airportsById: Map<string, Airport>): Set<string> {
  const sorted = sortLegs(legs)
  const ids = new Set<string>()
  for (let i = 1; i < sorted.length; i++) {
    const prev = airportsById.get(sorted[i - 1].arrivalAirportId)
    const cur = airportsById.get(sorted[i].departureAirportId)
    if (prev && cur && prev.iata !== cur.iata) ids.add(sorted[i].id)
  }
  return ids
}

export const formatKm = (km: number) => `${km.toLocaleString('zh-CN')} km`
