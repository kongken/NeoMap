import type { LngLat } from '@/types'

/** 平均地球半径（km），IUGG 推荐值 */
export const EARTH_RADIUS_KM = 6371.0088

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 将经度规范到 [-180, 180) */
export function normalizeLng(lng: number): number {
  const n = ((((lng + 180) % 360) + 360) % 360) - 180
  return Object.is(n, -0) ? 0 : n
}

export function isValidCoord([lng, lat]: LngLat): boolean {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

/** 两点中心角（弧度），haversine 形式，近点数值稳定 */
export function centralAngle(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1])
  const φ2 = toRad(b[1])
  const dφ = φ2 - φ1
  const dλ = toRad(b[0] - a[0])
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * Math.asin(Math.sqrt(clamp(h, 0, 1)))
}

/** 大圆距离（km） */
export function distanceKm(a: LngLat, b: LngLat): number {
  return centralAngle(a, b) * EARTH_RADIUS_KM
}

/** 初始方位角（度，正北为 0，顺时针） */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = toRad(a[1])
  const φ2 = toRad(b[1])
  const dλ = toRad(b[0] - a[0])
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return 0
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

type Vec3 = [number, number, number]
const toVec = ([lng, lat]: LngLat): Vec3 => {
  const φ = toRad(lat)
  const λ = toRad(lng)
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)]
}
const fromVec = ([x, y, z]: Vec3): LngLat => {
  const lat = toDeg(Math.atan2(z, Math.hypot(x, y)))
  // 极点处经度无意义，atan2(0,0)=0，结果仍为有限数
  const lng = toDeg(Math.atan2(y, x))
  return [lng, lat]
}

/** 近重合阈值：约 0.1 km 以内视为同一点 */
const COINCIDENT_RAD = 0.1 / EARTH_RADIUS_KM
/** 近对跖阈值：剩余角小于约 1 km 时，大圆不唯一 */
const ANTIPODAL_RAD = 1 / EARTH_RADIUS_KM

export type RouteWarning = 'coincident' | 'antipodal'

export interface GreatCircleRoute {
  /** 展开经度（连续，可能超出 ±180）的插值点，[lng, lat] */
  unwrapped: LngLat[]
  /** 每个点的累计距离（km），与 unwrapped 一一对应 */
  cumulativeKm: number[]
  totalKm: number
  warning?: RouteWarning
}

/**
 * 沿大圆插值（球面线性插值）。
 * - 返回的经度是「展开」的：相邻点经度差始终 < 180°，便于绘制与视野适配。
 * - 近重合：返回两点直线，不产生 NaN。
 * - 近对跖：大圆不唯一，退化为经过两点中点经度的子午线方向的确定路径，并给出 warning。
 */
export function greatCircleRoute(from: LngLat, to: LngLat, opts: { stepKm?: number; minPoints?: number } = {}): GreatCircleRoute {
  const stepKm = opts.stepKm ?? 50
  const minPoints = opts.minPoints ?? 16
  const ω = centralAngle(from, to)
  const totalKm = ω * EARTH_RADIUS_KM

  if (ω < COINCIDENT_RAD) {
    const unwrapped = unwrapPath([from, to])
    return { unwrapped, cumulativeKm: [0, totalKm], totalKm, warning: 'coincident' }
  }

  const n = Math.max(minPoints, Math.min(2000, Math.ceil(totalKm / stepKm)))
  const a = toVec(from)
  const b = toVec(to)
  let warning: RouteWarning | undefined

  const points: LngLat[] = []
  if (Math.PI - ω < ANTIPODAL_RAD) {
    // 对跖：选择一个确定的中间点（沿起点所在经线向北极/南极方向的 90° 点）构造路径
    warning = 'antipodal'
    const mid: LngLat = from[1] >= 0 ? [from[0] + 180, 90 - from[1]] : [from[0], 90 + from[1]]
    const half = Math.ceil(n / 2)
    const first = slerpPoints(a, toVec(mid), half)
    const second = slerpPoints(toVec(mid), b, n - half)
    points.push(...first, ...second.slice(1))
  } else {
    points.push(...slerpPoints(a, b, n))
  }
  // 端点精确等于输入
  points[0] = [from[0], from[1]]
  points[points.length - 1] = [to[0], to[1]]

  const unwrapped = unwrapPath(points)
  const cumulativeKm = [0]
  for (let i = 1; i < points.length; i++) {
    cumulativeKm.push(cumulativeKm[i - 1] + distanceKm(points[i - 1], points[i]))
  }
  // 以解析总距离为准，消除累加误差
  const sum = cumulativeKm[cumulativeKm.length - 1]
  const scale = sum > 0 ? (warning === 'antipodal' ? 1 : totalKm / sum) : 1
  for (let i = 0; i < cumulativeKm.length; i++) cumulativeKm[i] *= scale
  return { unwrapped, cumulativeKm, totalKm: cumulativeKm[cumulativeKm.length - 1], warning }
}

function slerpPoints(a: Vec3, b: Vec3, segments: number): LngLat[] {
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)
  const ω = Math.acos(dot)
  const sinω = Math.sin(ω)
  const out: LngLat[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    let v: Vec3
    if (sinω < 1e-9) {
      v = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    } else {
      const k1 = Math.sin((1 - t) * ω) / sinω
      const k2 = Math.sin(t * ω) / sinω
      v = [k1 * a[0] + k2 * b[0], k1 * a[1] + k2 * b[1], k1 * a[2] + k2 * b[2]]
    }
    out.push(fromVec(v))
  }
  return out
}

/** 展开经度，使相邻点经度差 ≤ 180°（路径连续，不横贯世界） */
export function unwrapPath(points: LngLat[]): LngLat[] {
  if (points.length === 0) return []
  const out: LngLat[] = [[points[0][0], points[0][1]]]
  for (let i = 1; i < points.length; i++) {
    const prev = out[i - 1][0]
    let lng = points[i][0]
    // 极点附近经度可能跳变，按最短方向展开
    while (lng - prev > 180) lng -= 360
    while (lng - prev < -180) lng += 360
    out.push([lng, points[i][1]])
  }
  return out
}

/**
 * 将展开路径切分为标准经度 [-180,180] 内的多段线（MultiLineString），
 * 在 ±180° 处插入交点，用于导出或不支持展开坐标的场景。
 */
export function splitAtAntimeridian(unwrapped: LngLat[]): LngLat[][] {
  if (unwrapped.length === 0) return []
  const parts: LngLat[][] = []
  let current: LngLat[] = []
  let prevShift = Math.floor((unwrapped[0][0] + 180) / 360)
  for (let i = 0; i < unwrapped.length; i++) {
    const [lng, lat] = unwrapped[i]
    const shift = Math.floor((lng + 180) / 360)
    if (i > 0 && shift !== prevShift) {
      const [plng, plat] = unwrapped[i - 1]
      const boundary = shift > prevShift ? shift * 360 - 180 : prevShift * 360 - 180
      const t = (boundary - plng) / (lng - plng)
      const latX = plat + (lat - plat) * t
      const edgeOut = shift > prevShift ? 180 : -180
      current.push([edgeOut, latX])
      parts.push(current)
      current = [[-edgeOut, latX]]
    }
    current.push([lng - shift * 360, lat])
    prevShift = shift
  }
  parts.push(current)
  return parts.filter((p) => p.length >= 2)
}

/** 按累计距离取点（展开经度）与方位角 */
export function pointAtDistance(route: GreatCircleRoute, km: number): { position: LngLat; bearing: number } {
  const { unwrapped, cumulativeKm } = route
  const n = unwrapped.length
  if (n === 1) return { position: unwrapped[0], bearing: 0 }
  const d = clamp(km, 0, route.totalKm)
  // 二分查找所在段
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumulativeKm[mid] <= d) lo = mid
    else hi = mid
  }
  const segLen = cumulativeKm[hi] - cumulativeKm[lo]
  const t = segLen > 0 ? (d - cumulativeKm[lo]) / segLen : 0
  const a = unwrapped[lo]
  const b = unwrapped[hi]
  const position: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  return { position, bearing: bearing(a, b) }
}

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

/**
 * 最短覆盖经度范围：在圆周上找到最大的经度空隙，范围为其补集。
 * 返回的 west ≤ east，east 可能 > 180（跨经线时），适合 fitBounds。
 */
export function shortestLngSpan(lngs: number[]): { west: number; east: number } {
  if (lngs.length === 0) return { west: -180, east: 180 }
  const sorted = [...new Set(lngs.map(normalizeLng))].sort((a, b) => a - b)
  if (sorted.length === 1) return { west: sorted[0], east: sorted[0] }
  let maxGap = -1
  let gapIndex = 0
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const next = i === sorted.length - 1 ? sorted[0] + 360 : sorted[i + 1]
    const gap = next - cur
    if (gap > maxGap) {
      maxGap = gap
      gapIndex = i
    }
  }
  // 空隙 (sorted[gapIndex], sorted[gapIndex+1]) 之外为覆盖范围
  const west = gapIndex === sorted.length - 1 ? sorted[0] : sorted[gapIndex + 1]
  let east = sorted[gapIndex]
  if (east < west) east += 360
  return { west, east }
}

export function boundsOf(points: LngLat[]): Bounds | null {
  const valid = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (valid.length === 0) return null
  const { west, east } = shortestLngSpan(valid.map((p) => p[0]))
  const lats = valid.map((p) => p[1])
  return { west, east, south: Math.min(...lats), north: Math.max(...lats) }
}

/** 路径从起点到指定距离的部分（展开经度），用于播放时已飞过的轨迹 */
export function pathUntil(route: GreatCircleRoute, km: number): LngLat[] {
  const d = clamp(km, 0, route.totalKm)
  const out: LngLat[] = []
  for (let i = 0; i < route.unwrapped.length && route.cumulativeKm[i] < d; i++) out.push(route.unwrapped[i])
  out.push(pointAtDistance(route, d).position)
  return out
}
