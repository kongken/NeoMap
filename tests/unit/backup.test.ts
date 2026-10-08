import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildBackup, MAX_BACKUP_BYTES, parseBackup, planImport } from '@/lib/backup/backup'
import { HolidayDb } from '@/lib/db'
import { TripRepository } from '@/lib/repositories/tripRepository'
import type { Airport, BackupV1 } from '@/types'
import fixtures from '../fixtures/airports.json'

const A = fixtures as Record<string, Airport>
const TS = '2026-10-01T00:00:00.000Z'

function validBackup(): BackupV1 {
  return {
    schemaVersion: 1,
    app: 'holiday-flight-map',
    exportedAt: TS,
    trips: [{ id: 't1', title: '亚洲假期', startDate: '2026-09-26', endDate: '2026-10-05', createdAt: TS, updatedAt: TS }],
    legs: [
      { id: 'l2', tripId: 't1', departureAirportId: A.ICN.id, arrivalAirportId: A.HKT.id, departureDate: '2026-09-26', order: 5, createdAt: TS, updatedAt: TS },
      { id: 'l1', tripId: 't1', departureAirportId: A.YNZ.id, arrivalAirportId: A.ICN.id, departureDate: '2026-09-26', flightNumber: 'KE1', order: 1, createdAt: TS, updatedAt: TS },
    ],
    airports: [A.YNZ, A.ICN, A.HKT],
  }
}

const parse = (b: unknown) => parseBackup(JSON.stringify(b))

describe('parseBackup', () => {
  it('接受合法备份', () => {
    const r = parse(validBackup())
    expect(r.ok).toBe(true)
  })

  it('拒绝非法 JSON', () => {
    expect(parseBackup('{not json')).toEqual({ ok: false, error: '文件不是有效的 JSON' })
  })

  it('拒绝超过 5 MB', () => {
    const r = parseBackup('{}', MAX_BACKUP_BYTES + 1)
    expect(r.ok).toBe(false)
  })

  it('拒绝不支持的未来版本', () => {
    const r = parse({ ...validBackup(), schemaVersion: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('更新的应用版本')
  })

  it('拒绝其他应用的文件', () => {
    expect(parse({ ...validBackup(), app: 'other' }).ok).toBe(false)
  })

  it('拒绝重复 ID', () => {
    const b = validBackup()
    b.legs[1].id = 'l2'
    const r = parse(b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('重复 ID')
  })

  it('拒绝悬空引用（假期、机场）', () => {
    const b1 = validBackup()
    b1.legs[0].tripId = 'nope'
    expect(parse(b1).ok).toBe(false)
    const b2 = validBackup()
    b2.legs[0].arrivalAirportId = 'nope'
    expect(parse(b2).ok).toBe(false)
  })

  it('拒绝非法日期与越界坐标', () => {
    const b1 = validBackup()
    b1.legs[0].departureDate = '2026-02-30'
    expect(parse(b1).ok).toBe(false)
    const b2 = validBackup()
    b2.airports[0] = { ...b2.airports[0], latitude: 91 }
    expect(parse(b2).ok).toBe(false)
    const b3 = validBackup()
    b3.trips[0].endDate = '2026-09-01'
    expect(parse(b3).ok).toBe(false)
  })

  it('拒绝超长字段', () => {
    const b = validBackup()
    b.trips[0].title = 'x'.repeat(81)
    expect(parse(b).ok).toBe(false)
  })
})

describe('planImport', () => {
  it('所有对象生成新 ID 并重建关联、规范化顺序', () => {
    let n = 0
    const plan = planImport(validBackup(), () => `id${++n}`)
    expect(plan.trips[0].id).not.toBe('t1')
    expect(plan.legs.map((l) => l.order)).toEqual([0, 1])
    // 按原 order 排序：YNZ→ICN 在前
    const airportIata = new Map(plan.airports.map((a) => [a.id, a.iata]))
    expect(plan.legs.map((l) => `${airportIata.get(l.departureAirportId)}-${airportIata.get(l.arrivalAirportId)}`)).toEqual(['YNZ-ICN', 'ICN-HKT'])
    for (const l of plan.legs) {
      expect(l.tripId).toBe(plan.trips[0].id)
      expect(['l1', 'l2']).not.toContain(l.id)
    }
    // 每个机场一个快照，id 全新
    expect(plan.airports).toHaveLength(3)
    for (const a of plan.airports) {
      expect(a.id.startsWith('snap:')).toBe(true)
      expect(a.key).toBe(`${plan.trips[0].id}:${a.id}`)
    }
  })
})

describe('repository round trip', () => {
  let repo: TripRepository
  beforeEach(async () => {
    const db = new HolidayDb(`test-${crypto.randomUUID()}`)
    repo = new TripRepository(db)
    await repo.open()
  })

  it('导出后再导入可恢复内容、顺序和机场快照，且不覆盖原数据', async () => {
    const trip = await repo.createTrip({ title: '亚洲假期', startDate: '2026-09-26' })
    await repo.addLeg(trip.id, { departure: A.YNZ, arrival: A.ICN, departureDate: '2026-09-26', flightNumber: 'oz 350' })
    await repo.addLeg(trip.id, { departure: A.ICN, arrival: A.HKT, departureDate: '2026-09-26' })
    const leg3 = await repo.addLeg(trip.id, { departure: A.HKT, arrival: A.ICN, departureDate: '2026-10-02' })
    await repo.moveLeg(leg3.id, -1)

    const backup = await repo.exportBackup()
    const json = JSON.stringify(backup)
    const parsed = parseBackup(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(await repo.findDuplicateTrips(parsed.backup)).toEqual(['亚洲假期'])
    await repo.applyImport(repo.planImport(parsed.backup))

    const trips = await repo.listTrips()
    expect(trips).toHaveLength(2)
    const [orig, copy] = await Promise.all(trips.map((t) => repo.getBundle(t.id)))
    const describe = (b: NonNullable<typeof orig>) => {
      const ap = new Map(b.airports.map((a) => [a.id, a]))
      return b.legs.map((l) => ({
        order: l.order,
        route: `${ap.get(l.departureAirportId)!.iata}-${ap.get(l.arrivalAirportId)!.iata}`,
        lat: ap.get(l.arrivalAirportId)!.latitude,
        date: l.departureDate,
        flightNumber: l.flightNumber,
      }))
    }
    expect(describe(copy!)).toEqual(describe(orig!))
    expect(describe(orig!).map((x) => x.route)).toEqual(['YNZ-ICN', 'HKT-ICN', 'ICN-HKT'])
    expect(copy!.trip.title).toBe('亚洲假期')
    expect(copy!.trip.id).not.toBe(orig!.trip.id)
  })

  it('导入事务失败时不产生部分写入', async () => {
    const parsed = parseBackup(JSON.stringify(validBackup()))
    if (!parsed.ok) throw new Error(parsed.error)
    const plan = repo.planImport(parsed.backup)
    // 人为制造冲突：航段 id 重复导致 bulkAdd 失败
    plan.legs[1].id = plan.legs[0].id
    await expect(repo.applyImport(plan)).rejects.toThrow()
    expect(await repo.listTrips()).toHaveLength(0)
  })

  it('删除航段后 order 连续，删除假期级联', async () => {
    const trip = await repo.createTrip({ title: 'T' })
    const l1 = await repo.addLeg(trip.id, { departure: A.YNZ, arrival: A.ICN, departureDate: '2026-09-26' })
    await repo.addLeg(trip.id, { departure: A.ICN, arrival: A.HKT, departureDate: '2026-09-26' })
    await repo.addLeg(trip.id, { departure: A.HKT, arrival: A.HKG, departureDate: '2026-09-27' })
    await repo.deleteLeg(l1.id)
    const b = await repo.getBundle(trip.id)
    expect(b!.legs.map((l) => l.order)).toEqual([0, 1])
    // YNZ 快照被清理
    expect(b!.airports.map((a) => a.iata).sort()).toEqual(['HKG', 'HKT', 'ICN'])
    await repo.deleteTrip(trip.id)
    expect(await repo.getBundle(trip.id)).toBeNull()
    const backup = await repo.exportBackup()
    expect(backup.legs).toHaveLength(0)
    expect(backup.airports).toHaveLength(0)
  })

  it('同一航段起终点相同被拒绝', async () => {
    const trip = await repo.createTrip({ title: 'T' })
    await expect(repo.addLeg(trip.id, { departure: A.ICN, arrival: A.ICN, departureDate: '2026-09-26' })).rejects.toThrow()
  })

  it('同 id 不同坐标的快照导出时不被合并', () => {
    const snapA = { ...A.ICN, key: 'a:' + A.ICN.id, tripId: 'a' }
    const snapB = { ...A.ICN, latitude: 37.5, key: 'b:' + A.ICN.id, tripId: 'b' }
    const hkt = (t: string) => ({ ...A.HKT, key: `${t}:${A.HKT.id}`, tripId: t })
    const leg = (id: string, tripId: string) => ({ id, tripId, departureAirportId: A.ICN.id, arrivalAirportId: A.HKT.id, departureDate: '2026-09-26', order: 0, createdAt: TS, updatedAt: TS })
    const trips = ['a', 'b'].map((id) => ({ id, title: id, createdAt: TS, updatedAt: TS }))
    const b = buildBackup(trips, [leg('1', 'a'), leg('2', 'b')], [snapA, snapB, hkt('a'), hkt('b')])
    expect(b.airports.filter((a) => a.iata === 'ICN')).toHaveLength(2)
    expect(b.legs[0].departureAirportId).not.toBe(b.legs[1].departureAirportId)
    expect(parseBackup(JSON.stringify(b)).ok).toBe(true)
  })
})
