import { z } from 'zod'
import type { Airport, BackupV1, FlightLeg, ReferencedAirport, Trip } from '@/types'
import { isValidIsoDate, LIMITS } from '@/lib/validation'

export const BACKUP_APP = 'holiday-flight-map'
export const CURRENT_SCHEMA_VERSION = 1
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024

const id = z.string().min(1).max(200)
const isoDate = z.string().refine(isValidIsoDate, '无效日期')
const timestamp = z.iso.datetime({ offset: true })
const optText = (max: number) => z.string().max(max).optional()

const tripSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(LIMITS.title),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    notes: optText(LIMITS.notes),
    isSample: z.boolean().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine((t) => !t.startDate || !t.endDate || t.endDate >= t.startDate, '结束日期早于开始日期')

const legSchema = z.object({
  id,
  tripId: id,
  departureAirportId: id,
  arrivalAirportId: id,
  departureDate: isoDate,
  flightNumber: optText(LIMITS.flightNumber),
  airline: optText(LIMITS.airline),
  notes: optText(LIMITS.notes),
  order: z.number().int().min(0).max(100000),
  createdAt: timestamp,
  updatedAt: timestamp,
})

const airportSchema = z.object({
  id,
  iata: z.string().regex(/^[A-Z]{3}$/),
  name: z.string().min(1).max(200),
  nameZh: z.string().max(200).optional(),
  city: z.string().max(200).optional(),
  cityZh: z.string().max(200).optional(),
  aliases: z.array(z.string().max(100)).max(50).optional(),
  countryCode: z.string().min(1).max(8),
  countryName: z.string().max(200).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
})

const backupSchema = z.object({
  schemaVersion: z.literal(1),
  app: z.literal(BACKUP_APP),
  exportedAt: timestamp,
  trips: z.array(tripSchema).max(1000),
  legs: z.array(legSchema).max(20000),
  airports: z.array(airportSchema).max(20000),
})

export type ParseResult = { ok: true; backup: BackupV1 } | { ok: false; error: string }

/** 解析并校验备份文本。任何失败都只返回错误，不产生副作用。 */
export function parseBackup(text: string, byteSize = new Blob([text]).size): ParseResult {
  if (byteSize > MAX_BACKUP_BYTES) return { ok: false, error: '文件超过 5 MB，无法导入' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: '备份文件结构无效' }
  const obj = raw as Record<string, unknown>
  if (obj.app !== BACKUP_APP) return { ok: false, error: '这不是 Holiday Flight Map 的备份文件' }
  if (typeof obj.schemaVersion !== 'number' || !Number.isInteger(obj.schemaVersion)) {
    return { ok: false, error: '备份文件缺少有效的版本号' }
  }
  if (obj.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return { ok: false, error: `备份版本 ${obj.schemaVersion} 来自更新的应用版本，当前仅支持版本 ${CURRENT_SCHEMA_VERSION}` }
  }
  if (obj.schemaVersion !== CURRENT_SCHEMA_VERSION) return { ok: false, error: `不支持的备份版本：${obj.schemaVersion}` }

  const parsed = backupSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `备份内容校验失败：${issue.path.join('.') || '根'} — ${issue.message}` }
  }
  const backup = parsed.data as BackupV1

  const dup = findDuplicate(backup.trips.map((t) => t.id)) ?? findDuplicate(backup.legs.map((l) => l.id)) ?? findDuplicate(backup.airports.map((a) => a.id))
  if (dup) return { ok: false, error: `备份中存在重复 ID：${dup}` }

  const tripIds = new Set(backup.trips.map((t) => t.id))
  const airports = new Map(backup.airports.map((a) => [a.id, a]))
  for (const leg of backup.legs) {
    if (!tripIds.has(leg.tripId)) return { ok: false, error: `航段 ${leg.id} 引用了不存在的假期` }
    const from = airports.get(leg.departureAirportId)
    const to = airports.get(leg.arrivalAirportId)
    if (!from || !to) return { ok: false, error: `航段 ${leg.id} 引用了不存在的机场` }
    if (from.iata === to.iata) return { ok: false, error: `航段 ${leg.id} 的出发和到达机场相同` }
  }
  return { ok: true, backup }
}

function findDuplicate(ids: string[]): string | null {
  const seen = new Set<string>()
  for (const x of ids) {
    if (seen.has(x)) return x
    seen.add(x)
  }
  return null
}

export interface ImportPlan {
  trips: Trip[]
  legs: FlightLeg[]
  airports: ReferencedAirport[]
}

/**
 * 生成导入计划：所有对象使用新 ID，按行程隔离机场快照，并规范化航段 order。
 * 航段引用指向本次生成的快照，不会与现有同 ID 机场合并。
 */
export function planImport(backup: BackupV1, newId: () => string = () => crypto.randomUUID()): ImportPlan {
  const airportsById = new Map(backup.airports.map((a) => [a.id, a]))
  const trips: Trip[] = []
  const legs: FlightLeg[] = []
  const airports: ReferencedAirport[] = []

  for (const trip of backup.trips) {
    const tripId = newId()
    trips.push({ ...trip, id: tripId })
    const airportMap = new Map<string, string>()
    const snapFor = (oldId: string) => {
      let nid = airportMap.get(oldId)
      if (!nid) {
        nid = `snap:${newId()}`
        airportMap.set(oldId, nid)
        const src = airportsById.get(oldId)!
        airports.push({ ...src, id: nid, key: `${tripId}:${nid}`, tripId })
      }
      return nid
    }
    const tripLegs = backup.legs.filter((l) => l.tripId === trip.id).sort((a, b) => a.order - b.order)
    tripLegs.forEach((leg, i) => {
      legs.push({
        ...leg,
        id: newId(),
        tripId,
        departureAirportId: snapFor(leg.departureAirportId),
        arrivalAirportId: snapFor(leg.arrivalAirportId),
        order: i,
      })
    })
  }
  return { trips, legs, airports }
}

/** 构建备份：机场快照按 id 去重；同 id 但内容不同的快照分配新导出 id 并改写引用 */
export function buildBackup(trips: Trip[], legs: FlightLeg[], snapshots: ReferencedAirport[], now = new Date()): BackupV1 {
  const byKey = new Map(snapshots.map((s) => [s.key, s]))
  const exported = new Map<string, Airport>()
  const outLegs: FlightLeg[] = []

  const exportAirport = (tripId: string, airportId: string): string => {
    const snap = byKey.get(`${tripId}:${airportId}`)
    if (!snap) throw new Error(`缺少机场快照：${airportId}`)
    const { key: _key, tripId: _tripId, ...airport } = snap
    let exportId = airport.id
    let n = 1
    while (exported.has(exportId) && !sameAirport(exported.get(exportId)!, airport)) {
      n++
      exportId = `${airport.id}#${n}`
    }
    if (!exported.has(exportId)) exported.set(exportId, { ...airport, id: exportId })
    return exportId
  }

  for (const leg of legs) {
    outLegs.push({
      ...leg,
      departureAirportId: exportAirport(leg.tripId, leg.departureAirportId),
      arrivalAirportId: exportAirport(leg.tripId, leg.arrivalAirportId),
    })
  }
  return {
    schemaVersion: 1,
    app: BACKUP_APP,
    exportedAt: now.toISOString(),
    trips,
    legs: outLegs,
    airports: [...exported.values()],
  }
}

function sameAirport(a: Airport, b: Airport): boolean {
  return JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort())
}

/** 行程指纹：标题 + 日期 + 航段（IATA 与日期序列），用于提示重复导入 */
export function tripFingerprint(trip: Pick<Trip, 'title' | 'startDate' | 'endDate'>, legs: FlightLeg[], airportIata: (legTripId: string, airportId: string) => string | undefined): string {
  const legPart = [...legs]
    .sort((a, b) => a.order - b.order)
    .map((l) => `${airportIata(l.tripId, l.departureAirportId)}>${airportIata(l.tripId, l.arrivalAirportId)}@${l.departureDate}`)
    .join(',')
  return `${trip.title.trim()}|${trip.startDate ?? ''}|${trip.endDate ?? ''}|${legPart}`
}
