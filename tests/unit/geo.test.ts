import { describe, expect, it } from 'vitest'
import {
  boundsOf,
  distanceKm,
  greatCircleRoute,
  normalizeLng,
  pointAtDistance,
  shortestLngSpan,
  splitAtAntimeridian,
} from '@/lib/geo/greatCircle'
import { buildTripGeometry, computeStats, coordOf } from '@/lib/geo/tripGeometry'
import type { Airport, FlightLeg, LngLat } from '@/types'
import fixtures from '../fixtures/airports.json'

const A = fixtures as Record<string, Airport>
const NRT = coordOf(A.NRT)
const LAX = coordOf(A.LAX)
const AKL = coordOf(A.AKL)

const finite = (pts: LngLat[]) => pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
const maxJump = (pts: LngLat[]) => Math.max(...pts.slice(1).map((p, i) => Math.abs(p[0] - pts[i][0])))

describe('distanceKm', () => {
  it('同坐标距离为 0', () => {
    expect(distanceKm(NRT, NRT)).toBe(0)
  })
  it('距离对称', () => {
    expect(distanceKm(NRT, LAX)).toBeCloseTo(distanceKm(LAX, NRT), 9)
  })
  it('NRT → LAX 约 8,750 km', () => {
    expect(distanceKm(NRT, LAX)).toBeGreaterThan(8700)
    expect(distanceKm(NRT, LAX)).toBeLessThan(8800)
  })
})

describe('greatCircleRoute', () => {
  it('端点与输入一致（标准化后）', () => {
    const r = greatCircleRoute(NRT, LAX)
    const first = r.unwrapped[0]
    const last = r.unwrapped[r.unwrapped.length - 1]
    expect(first).toEqual(NRT)
    expect(normalizeLng(last[0])).toBeCloseTo(LAX[0], 9)
    expect(last[1]).toBeCloseTo(LAX[1], 9)
  })

  it('NRT → LAX 跨经线：展开经度连续，无全球连线', () => {
    const r = greatCircleRoute(NRT, LAX)
    expect(finite(r.unwrapped)).toBe(true)
    expect(maxJump(r.unwrapped)).toBeLessThan(5)
    // 经太平洋：终点在展开坐标中位于 180° 以东
    expect(r.unwrapped[r.unwrapped.length - 1][0]).toBeGreaterThan(180)
    // 大圆航线向北弯曲
    expect(Math.max(...r.unwrapped.map((p) => p[1]))).toBeGreaterThan(45)
  })

  it('AKL → LAX 跨经线', () => {
    const r = greatCircleRoute(AKL, LAX)
    expect(maxJump(r.unwrapped)).toBeLessThan(5)
    expect(r.totalKm).toBeCloseTo(distanceKm(AKL, LAX), 3)
  })

  it('累计距离单调递增，终值等于总距离', () => {
    const r = greatCircleRoute(NRT, LAX)
    for (let i = 1; i < r.cumulativeKm.length; i++) expect(r.cumulativeKm[i]).toBeGreaterThanOrEqual(r.cumulativeKm[i - 1])
    expect(r.cumulativeKm.at(-1)).toBeCloseTo(distanceKm(NRT, LAX), 6)
  })

  it('近重合不产生 NaN', () => {
    const r = greatCircleRoute([10, 10], [10.0000001, 10])
    expect(r.warning).toBe('coincident')
    expect(finite(r.unwrapped)).toBe(true)
    expect(Number.isFinite(pointAtDistance(r, 0.00001).position[0])).toBe(true)
  })

  it('近对跖点不产生 NaN', () => {
    const r = greatCircleRoute([0, 10], [180, -10])
    expect(r.warning).toBe('antipodal')
    expect(finite(r.unwrapped)).toBe(true)
    expect(r.totalKm).toBeGreaterThan(19000)
    const r2 = greatCircleRoute([0, 10], [179.99999, -9.99999])
    expect(finite(r2.unwrapped)).toBe(true)
  })

  it('极区坐标不产生 NaN', () => {
    const r = greatCircleRoute([0, 89.9999], [100, -89.9999])
    expect(finite(r.unwrapped)).toBe(true)
    const r2 = greatCircleRoute([-150, 90], [30, 80])
    expect(finite(r2.unwrapped)).toBe(true)
  })
})

describe('splitAtAntimeridian', () => {
  it('切分后每段经度在 [-180,180] 内且无大跃迁', () => {
    const parts = splitAtAntimeridian(greatCircleRoute(NRT, LAX).unwrapped)
    expect(parts.length).toBe(2)
    for (const p of parts) {
      expect(p.every(([x]) => x >= -180 && x <= 180)).toBe(true)
      expect(maxJump(p)).toBeLessThan(5)
    }
    expect(parts[0].at(-1)![0]).toBe(180)
    expect(parts[1][0][0]).toBe(-180)
    expect(parts[0].at(-1)![1]).toBeCloseTo(parts[1][0][1], 9)
  })
  it('不跨经线时只有一段', () => {
    expect(splitAtAntimeridian(greatCircleRoute(coordOf(A.ICN), coordOf(A.HKT)).unwrapped)).toHaveLength(1)
  })
})

describe('pointAtDistance', () => {
  it('首尾与端点重合，方位角有限', () => {
    const r = greatCircleRoute(NRT, LAX)
    expect(pointAtDistance(r, 0).position).toEqual(r.unwrapped[0])
    const end = pointAtDistance(r, r.totalKm).position
    expect(end[0]).toBeCloseTo(r.unwrapped.at(-1)![0], 9)
    // 越界距离被夹紧
    expect(pointAtDistance(r, r.totalKm * 2).position).toEqual(end)
    expect(Number.isFinite(pointAtDistance(r, r.totalKm / 2).bearing)).toBe(true)
  })
  it('沿路径连续（相邻采样无突跳）', () => {
    const r = greatCircleRoute(NRT, LAX)
    let prev = pointAtDistance(r, 0).position
    for (let i = 1; i <= 200; i++) {
      const p = pointAtDistance(r, (r.totalKm * i) / 200).position
      expect(Math.abs(p[0] - prev[0])).toBeLessThan(2)
      prev = p
    }
  })
})

describe('bounds', () => {
  it('跨经线时选择最短经度覆盖（太平洋）', () => {
    const span = shortestLngSpan([NRT[0], LAX[0]])
    expect(span.west).toBeCloseTo(NRT[0], 6)
    expect(span.east).toBeCloseTo(LAX[0] + 360, 6)
    const b = boundsOf(greatCircleRoute(NRT, LAX).unwrapped)!
    expect(b.east - b.west).toBeLessThan(110)
  })
  it('不跨经线时等同 min/max', () => {
    const span = shortestLngSpan([100, 120, 110])
    expect(span).toEqual({ west: 100, east: 120 })
  })
})

describe('trip geometry & stats', () => {
  const mkLeg = (id: string, from: Airport, to: Airport, order: number): FlightLeg => ({
    id,
    tripId: 't',
    departureAirportId: from.id,
    arrivalAirportId: to.id,
    departureDate: '2026-09-26',
    order,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const byId = new Map(Object.values(A).map((a) => [a.id, a]))
  const legs = [mkLeg('1', A.YNZ, A.ICN, 0), mkLeg('2', A.ICN, A.HKT, 1), mkLeg('3', A.HKT, A.ICN, 2), mkLeg('4', A.ICN, A.HKG, 3)]

  it('共享机场只画一个标记', () => {
    const g = buildTripGeometry(legs, byId)
    expect(g.legs).toHaveLength(4)
    expect(g.airports.map((a) => a.iata).sort()).toEqual(['HKG', 'HKT', 'ICN', 'YNZ'])
  })

  it('统计：航段、机场、城市、距离', () => {
    const s = computeStats(legs, byId)
    expect(s.legCount).toBe(4)
    expect(s.airportCount).toBe(4)
    // 到达城市：Seoul, Phuket, Hong Kong（Seoul 重复）
    expect(s.cityCount).toBe(3)
    const expected = legs.reduce((sum, l) => sum + distanceKm(coordOf(byId.get(l.departureAirportId)!), coordOf(byId.get(l.arrivalAirportId)!)), 0)
    expect(s.totalKm).toBe(Math.round(expected))
  })

  it('缺少机场的航段被标记为无效而不崩溃', () => {
    const g = buildTripGeometry([{ ...legs[0], arrivalAirportId: 'missing' }], byId)
    expect(g.legs).toHaveLength(0)
    expect(g.invalidLegIds).toEqual(['1'])
  })
})
