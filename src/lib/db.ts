import Dexie, { type EntityTable } from 'dexie'
import type { FlightLeg, ReferencedAirport, Trip } from '@/types'
import type { PendingDelete, SyncAccount, TripSyncRecord } from '@/lib/sync/types'

export class HolidayDb extends Dexie {
  trips!: EntityTable<Trip, 'id'>
  legs!: EntityTable<FlightLeg, 'id'>
  referencedAirports!: EntityTable<ReferencedAirport, 'key'>
  /** 每个行程的云同步状态（与领域数据分开，备份格式不受影响） */
  tripSync!: EntityTable<TripSyncRecord, 'tripId'>
  /** 已在本地删除、尚未通知服务端的行程 */
  pendingDeletes!: EntityTable<PendingDelete, 'tripId'>
  /** 本设备关联的账号与同步游标（单行，key = 'account'） */
  syncMeta!: EntityTable<SyncAccount, 'key'>

  constructor(name = 'holiday-flight-map') {
    super(name)
    this.version(1).stores({
      trips: 'id, createdAt',
      legs: 'id, tripId, [tripId+order]',
      referencedAirports: 'key, tripId',
    })
    this.version(2)
      .stores({
        tripSync: 'tripId, state',
        pendingDeletes: 'tripId',
        syncMeta: 'key',
      })
      .upgrade(async (tx) => {
        // 已有行程尚未关联任何账号：标记为待同步，首次登录时由用户决定是否上传
        const trips = await tx.table('trips').toArray()
        await tx.table('tripSync').bulkPut(
          trips.map((t: Trip) => ({ tripId: t.id, state: 'dirty', serverRevision: 0, localOnly: false, localVersion: 1 }) satisfies TripSyncRecord),
        )
      })
  }
}

let instance: HolidayDb | null = null

export function getDb(): HolidayDb {
  if (!instance) instance = new HolidayDb()
  return instance
}
