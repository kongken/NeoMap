import type { Airport, BackupV1, FlightLeg, ReferencedAirport, Trip } from '@/types'
import type { HolidayDb } from '@/lib/db'
import { buildBackup, planImport, tripFingerprint, type ImportPlan } from '@/lib/backup/backup'
import { toSnapshot } from '@/lib/airports/catalog'
import { sortLegs } from '@/lib/geo/tripGeometry'

export interface TripInput {
  title: string
  startDate?: string
  endDate?: string
  notes?: string
}

export interface LegInput {
  departure: Airport
  arrival: Airport
  departureDate: string
  flightNumber?: string
  airline?: string
  notes?: string
}

export interface TripBundle {
  trip: Trip
  legs: FlightLeg[]
  airports: ReferencedAirport[]
}

const nowIso = () => new Date().toISOString()
const snapshotKey = (tripId: string, airportId: string) => `${tripId}:${airportId}`

/**
 * 行程数据仓库：集中管理读取与事务。UI 仅通过此接口访问本地存储，
 * 便于未来替换为远程 API。
 */
export class TripRepository {
  private readonly db: HolidayDb
  private readonly newId: () => string

  constructor(db: HolidayDb, newId: () => string = () => crypto.randomUUID()) {
    this.db = db
    this.newId = newId
  }

  async open(): Promise<void> {
    await this.db.open()
  }

  async listTrips(): Promise<Trip[]> {
    const trips = await this.db.trips.toArray()
    return trips.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async getBundle(tripId: string): Promise<TripBundle | null> {
    return this.db.transaction('r', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      const trip = await this.db.trips.get(tripId)
      if (!trip) return null
      const legs = sortLegs(await this.db.legs.where('tripId').equals(tripId).toArray())
      const airports = await this.db.referencedAirports.where('tripId').equals(tripId).toArray()
      return { trip, legs, airports }
    })
  }

  async createTrip(input: TripInput, extra: Partial<Pick<Trip, 'isSample'>> = {}): Promise<Trip> {
    const ts = nowIso()
    const trip: Trip = { id: this.newId(), ...clean(input), ...extra, createdAt: ts, updatedAt: ts }
    await this.db.trips.add(trip)
    return trip
  }

  async updateTrip(tripId: string, input: TripInput): Promise<Trip> {
    return this.db.transaction('rw', this.db.trips, async () => {
      const existing = await this.db.trips.get(tripId)
      if (!existing) throw new Error('假期不存在或已被删除')
      const { startDate: _s, endDate: _e, notes: _n, ...rest } = existing
      const trip: Trip = { ...rest, ...clean(input), updatedAt: nowIso() }
      await this.db.trips.put(trip)
      return trip
    })
  }

  /** 单个事务删除假期、其航段和机场快照 */
  async deleteTrip(tripId: string): Promise<void> {
    await this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      await this.db.legs.where('tripId').equals(tripId).delete()
      await this.db.referencedAirports.where('tripId').equals(tripId).delete()
      await this.db.trips.delete(tripId)
    })
  }

  async addLeg(tripId: string, input: LegInput): Promise<FlightLeg> {
    assertDifferent(input)
    return this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      if (!(await this.db.trips.get(tripId))) throw new Error('假期不存在或已被删除')
      const count = await this.db.legs.where('tripId').equals(tripId).count()
      const departureAirportId = await this.ensureSnapshot(tripId, input.departure)
      const arrivalAirportId = await this.ensureSnapshot(tripId, input.arrival)
      const ts = nowIso()
      const leg: FlightLeg = {
        id: this.newId(),
        tripId,
        departureAirportId,
        arrivalAirportId,
        departureDate: input.departureDate,
        ...cleanLegExtras(input),
        order: count,
        createdAt: ts,
        updatedAt: ts,
      }
      await this.db.legs.add(leg)
      await this.touchTrip(tripId)
      return leg
    })
  }

  async updateLeg(legId: string, input: LegInput): Promise<FlightLeg> {
    assertDifferent(input)
    return this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      const existing = await this.db.legs.get(legId)
      if (!existing) throw new Error('航段不存在或已被删除')
      const departureAirportId = await this.ensureSnapshot(existing.tripId, input.departure)
      const arrivalAirportId = await this.ensureSnapshot(existing.tripId, input.arrival)
      const leg: FlightLeg = {
        id: existing.id,
        tripId: existing.tripId,
        order: existing.order,
        createdAt: existing.createdAt,
        departureAirportId,
        arrivalAirportId,
        departureDate: input.departureDate,
        ...cleanLegExtras(input),
        updatedAt: nowIso(),
      }
      await this.db.legs.put(leg)
      await this.pruneSnapshots(existing.tripId)
      await this.touchTrip(existing.tripId)
      return leg
    })
  }

  async deleteLeg(legId: string): Promise<void> {
    await this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      const existing = await this.db.legs.get(legId)
      if (!existing) return
      await this.db.legs.delete(legId)
      await this.normalizeOrder(existing.tripId)
      await this.pruneSnapshots(existing.tripId)
      await this.touchTrip(existing.tripId)
    })
  }

  /** 上移(-1) / 下移(+1)，并规范化为连续 order */
  async moveLeg(legId: string, direction: -1 | 1): Promise<void> {
    await this.db.transaction('rw', this.db.trips, this.db.legs, async () => {
      const leg = await this.db.legs.get(legId)
      if (!leg) throw new Error('航段不存在或已被删除')
      const legs = sortLegs(await this.db.legs.where('tripId').equals(leg.tripId).toArray())
      const i = legs.findIndex((l) => l.id === legId)
      const j = i + direction
      if (j < 0 || j >= legs.length) return
      ;[legs[i], legs[j]] = [legs[j], legs[i]]
      const ts = nowIso()
      await this.db.legs.bulkPut(legs.map((l, order) => (l.order === order ? l : { ...l, order, updatedAt: ts })))
      await this.touchTrip(leg.tripId)
    })
  }

  async exportBackup(): Promise<BackupV1> {
    return this.db.transaction('r', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      const trips = await this.listTrips()
      const legs: FlightLeg[] = []
      for (const t of trips) legs.push(...sortLegs(await this.db.legs.where('tripId').equals(t.id).toArray()))
      const airports = await this.db.referencedAirports.toArray()
      return buildBackup(trips, legs, airports)
    })
  }

  planImport(backup: BackupV1): ImportPlan {
    return planImport(backup, this.newId)
  }

  /** 返回与现有数据重复（指纹相同）的待导入假期标题 */
  async findDuplicateTrips(backup: BackupV1): Promise<string[]> {
    const backupAirports = new Map(backup.airports.map((a) => [a.id, a.iata]))
    const incoming = backup.trips.map((t) => ({
      title: t.title,
      fp: tripFingerprint(t, backup.legs.filter((l) => l.tripId === t.id), (_tid, aid) => backupAirports.get(aid)),
    }))
    const existing = new Set<string>()
    const snaps = await this.db.referencedAirports.toArray()
    const snapIata = new Map(snaps.map((s) => [s.key, s.iata]))
    for (const t of await this.db.trips.toArray()) {
      const legs = await this.db.legs.where('tripId').equals(t.id).toArray()
      existing.add(tripFingerprint(t, legs, (tid, aid) => snapIata.get(snapshotKey(tid, aid))))
    }
    return incoming.filter((x) => existing.has(x.fp)).map((x) => x.title)
  }

  /** 单个事务追加写入；任一失败则整体回滚 */
  async applyImport(plan: ImportPlan): Promise<void> {
    await this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      await this.db.trips.bulkAdd(plan.trips)
      await this.db.referencedAirports.bulkAdd(plan.airports)
      await this.db.legs.bulkAdd(plan.legs)
    })
  }

  /** 示例行程：一次事务写入 */
  async createSampleTrip(title: string, legs: { from: Airport; to: Airport; date: string }[], range: { startDate: string; endDate: string }): Promise<Trip> {
    return this.db.transaction('rw', this.db.trips, this.db.legs, this.db.referencedAirports, async () => {
      const trip = await this.createTrip({ title, ...range, notes: '这是示例行程，可随时编辑或删除。' }, { isSample: true })
      for (const l of legs) await this.addLeg(trip.id, { departure: l.from, arrival: l.to, departureDate: l.date })
      return trip
    })
  }

  /**
   * 确保行程内存在该机场快照，返回航段应引用的机场 id。
   * - 已有同 id 快照：保持不变（静态目录更新不会改变旧行程中的机场）。
   * - 已有同 IATA 且坐标一致的快照（如导入的快照）：复用，避免重复机场。
   */
  private async ensureSnapshot(tripId: string, airport: Airport): Promise<string> {
    const key = snapshotKey(tripId, airport.id)
    if (await this.db.referencedAirports.get(key)) return airport.id
    const sameIata = (await this.db.referencedAirports.where('tripId').equals(tripId).toArray()).find(
      (s) => s.iata === airport.iata && Math.abs(s.latitude - airport.latitude) < 1e-4 && Math.abs(s.longitude - airport.longitude) < 1e-4,
    )
    if (sameIata) return sameIata.id
    await this.db.referencedAirports.add({ ...toSnapshot(airport), key, tripId })
    return airport.id
  }

  private async pruneSnapshots(tripId: string): Promise<void> {
    const legs = await this.db.legs.where('tripId').equals(tripId).toArray()
    const used = new Set(legs.flatMap((l) => [l.departureAirportId, l.arrivalAirportId]))
    const snaps = await this.db.referencedAirports.where('tripId').equals(tripId).toArray()
    const stale = snaps.filter((s) => !used.has(s.id)).map((s) => s.key)
    if (stale.length) await this.db.referencedAirports.bulkDelete(stale)
  }

  private async normalizeOrder(tripId: string): Promise<void> {
    const legs = sortLegs(await this.db.legs.where('tripId').equals(tripId).toArray())
    const changed = legs.map((l, order) => ({ l, order })).filter(({ l, order }) => l.order !== order)
    if (changed.length) await this.db.legs.bulkPut(changed.map(({ l, order }) => ({ ...l, order })))
  }

  private async touchTrip(tripId: string): Promise<void> {
    await this.db.trips.update(tripId, { updatedAt: nowIso() })
  }
}

function clean(input: TripInput): TripInput {
  const out: TripInput = { title: input.title.trim() }
  if (input.startDate) out.startDate = input.startDate
  if (input.endDate) out.endDate = input.endDate
  if (input.notes?.trim()) out.notes = input.notes.trim()
  return out
}

function cleanLegExtras(input: LegInput): Pick<FlightLeg, 'flightNumber' | 'airline' | 'notes'> {
  const out: Pick<FlightLeg, 'flightNumber' | 'airline' | 'notes'> = {}
  if (input.flightNumber?.trim()) out.flightNumber = input.flightNumber.trim().toUpperCase()
  if (input.airline?.trim()) out.airline = input.airline.trim()
  if (input.notes?.trim()) out.notes = input.notes.trim()
  return out
}

function assertDifferent(input: LegInput) {
  if (input.departure.iata === input.arrival.iata) throw new Error('出发和到达机场不能相同')
}
