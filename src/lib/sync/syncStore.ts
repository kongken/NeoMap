import type { HolidayDb } from '@/lib/db'
import { sortLegs } from '@/lib/geo/tripGeometry'
import type { LocalBundle } from './convert'
import type { PendingDelete, SyncAccount, TripSyncRecord } from './types'

/**
 * 同步引擎使用的本地存储操作。与 TripRepository 不同，这里的写入不会把行程标记为待同步
 * （它们本身就是同步的结果），也不会触发本地变更通知。
 */
export class SyncStore {
  private readonly db: HolidayDb
  private readonly newId: () => string

  constructor(db: HolidayDb, newId: () => string = () => crypto.randomUUID()) {
    this.db = db
    this.newId = newId
  }

  private tx<T>(fn: () => Promise<T>): Promise<T> {
    const d = this.db
    return d.transaction('rw', [d.trips, d.legs, d.referencedAirports, d.tripSync, d.pendingDeletes, d.syncMeta], fn)
  }

  // ---- 账号与游标 ----

  getAccount(): Promise<SyncAccount | undefined> {
    return this.db.syncMeta.get('account')
  }

  async linkAccount(userId: string, displayName: string): Promise<void> {
    await this.db.syncMeta.put({ key: 'account', userId, displayName, cursor: '' })
  }

  async renameAccount(displayName: string): Promise<void> {
    await this.db.syncMeta.update('account', { displayName })
  }

  async saveCursor(cursor: string): Promise<void> {
    await this.db.syncMeta.update('account', { cursor })
  }

  async setLastSynced(at: string): Promise<void> {
    await this.db.syncMeta.update('account', { lastSyncedAt: at })
  }

  // ---- 读取 ----

  getRecord(tripId: string): Promise<TripSyncRecord | undefined> {
    return this.db.tripSync.get(tripId)
  }

  listRecords(): Promise<TripSyncRecord[]> {
    return this.db.tripSync.toArray()
  }

  getPendingDelete(tripId: string): Promise<PendingDelete | undefined> {
    return this.db.pendingDeletes.get(tripId)
  }

  listPendingDeletes(): Promise<PendingDelete[]> {
    return this.db.pendingDeletes.toArray()
  }

  /** 需要上传的行程（有本地修改、参与同步） */
  async dirtyRecords(): Promise<TripSyncRecord[]> {
    return (await this.db.tripSync.where('state').equals('dirty').toArray()).filter((r) => !r.localOnly)
  }

  async readBundle(tripId: string): Promise<LocalBundle | null> {
    const d = this.db
    return d.transaction('r', [d.trips, d.legs, d.referencedAirports], async () => {
      const trip = await d.trips.get(tripId)
      if (!trip) return null
      return {
        trip,
        legs: sortLegs(await d.legs.where('tripId').equals(tripId).toArray()),
        airports: await d.referencedAirports.where('tripId').equals(tripId).toArray(),
      }
    })
  }

  /** 上传快照：内容与当时的本地修改计数一起读取，保证一致 */
  async readForPush(tripId: string): Promise<{ bundle: LocalBundle; localVersion: number } | null> {
    const d = this.db
    return d.transaction('r', [d.trips, d.legs, d.referencedAirports, d.tripSync], async () => {
      const rec = await d.tripSync.get(tripId)
      const bundle = await this.readBundle(tripId)
      return rec && bundle ? { bundle, localVersion: rec.localVersion } : null
    })
  }

  /** 统计未同步的内容（用于状态显示和退出前提醒） */
  async pendingCounts(): Promise<{ dirty: number; errors: number; deletes: number; localOnly: number }> {
    const recs = await this.db.tripSync.toArray()
    return {
      dirty: recs.filter((r) => r.state === 'dirty' && !r.localOnly).length,
      errors: recs.filter((r) => r.state === 'error' && !r.localOnly).length,
      deletes: await this.db.pendingDeletes.count(),
      localOnly: recs.filter((r) => r.localOnly).length,
    }
  }

  /** 从未上传过的行程数量（首次登录时询问是否上传） */
  async neverUploadedCount(): Promise<number> {
    return (await this.db.tripSync.toArray()).filter((r) => !r.localOnly && r.serverRevision === 0).length
  }

  // ---- 上传结果 ----

  /** 上传成功：记录服务端版本；上传期间没有新的本地修改时标记为已同步 */
  async markPushed(tripId: string, revision: number, localVersion: number): Promise<void> {
    await this.tx(async () => {
      const rec = await this.db.tripSync.get(tripId)
      if (rec) {
        const synced = rec.localVersion === localVersion
        await this.db.tripSync.put({ ...rec, serverRevision: revision, state: synced ? 'synced' : rec.state, error: undefined })
      }
      // 上传期间被本地删除：待删除记录需要基于新版本，否则服务端会判为冲突
      const pd = await this.db.pendingDeletes.get(tripId)
      if (pd) await this.db.pendingDeletes.put({ ...pd, serverRevision: revision })
    })
  }

  async setServerRevision(tripId: string, revision: number): Promise<void> {
    await this.db.tripSync.update(tripId, { serverRevision: revision })
  }

  async markError(tripId: string, message: string): Promise<void> {
    await this.db.tripSync.update(tripId, { state: 'error', error: message })
  }

  async removePendingDelete(tripId: string): Promise<void> {
    await this.db.pendingDeletes.delete(tripId)
  }

  // ---- 应用服务端内容 ----

  private async writeContent(b: LocalBundle): Promise<void> {
    const id = b.trip.id
    await this.db.legs.where('tripId').equals(id).delete()
    await this.db.referencedAirports.where('tripId').equals(id).delete()
    await this.db.trips.put(b.trip)
    await this.db.referencedAirports.bulkPut(b.airports)
    await this.db.legs.bulkPut(b.legs)
  }

  /** 用服务端版本覆盖本地行程，并标记为已同步 */
  async applyServer(b: LocalBundle, revision: number): Promise<void> {
    await this.tx(async () => {
      const rec = await this.db.tripSync.get(b.trip.id)
      await this.writeContent(b)
      await this.db.tripSync.put({
        tripId: b.trip.id,
        state: 'synced',
        serverRevision: revision,
        localOnly: false,
        localVersion: (rec?.localVersion ?? 0) + 1,
      })
      await this.db.pendingDeletes.delete(b.trip.id)
    })
  }

  /** 删除本地行程（服务端已删除），不产生待删除记录 */
  async deleteLocal(tripId: string): Promise<void> {
    await this.tx(async () => {
      await this.db.legs.where('tripId').equals(tripId).delete()
      await this.db.referencedAirports.where('tripId').equals(tripId).delete()
      await this.db.trips.delete(tripId)
      await this.db.tripSync.delete(tripId)
      await this.db.pendingDeletes.delete(tripId)
    })
  }

  /**
   * 以新 ID 另存一份（冲突副本或 ID 被占用时换 ID），新行程待上传。返回新行程 ID。
   * 机场快照 ID 不变（按行程隔离），航段换新 ID。
   */
  async saveAsNew(b: LocalBundle, title: string): Promise<string> {
    const tripId = this.newId()
    await this.tx(async () => {
      await this.writeContent({
        trip: { ...b.trip, id: tripId, title },
        legs: b.legs.map((l) => ({ ...l, id: this.newId(), tripId })),
        airports: b.airports.map((a) => ({ ...a, tripId, key: `${tripId}:${a.id}` })),
      })
      await this.db.tripSync.put({ tripId, state: 'dirty', serverRevision: 0, localOnly: false, localVersion: 1 })
    })
    return tripId
  }

  /** 全量同步后：删除服务端已不存在的已同步行程；有本地修改的改为重新创建。返回删除的数量。 */
  async reconcileAfterFullSync(seen: Set<string>): Promise<{ removed: number; recreate: number }> {
    let removed = 0
    let recreate = 0
    const recs = await this.db.tripSync.toArray()
    for (const r of recs) {
      if (r.localOnly || r.serverRevision === 0 || seen.has(r.tripId)) continue
      if (r.state === 'synced') {
        await this.deleteLocal(r.tripId)
        removed++
      } else {
        await this.setServerRevision(r.tripId, 0)
        recreate++
      }
    }
    return { removed, recreate }
  }

  // ---- 账号切换 / 退出 ----

  /** 首次登录选择「不上传」：把从未上传的行程设为「仅本设备」 */
  async markNeverUploadedLocalOnly(): Promise<void> {
    await this.tx(async () => {
      for (const r of await this.db.tripSync.toArray()) {
        if (!r.localOnly && r.serverRevision === 0) await this.db.tripSync.put({ ...r, localOnly: true })
      }
    })
  }

  /** 把「仅本设备」的行程加入同步 */
  async uploadLocalOnly(tripId: string): Promise<void> {
    await this.tx(async () => {
      const r = await this.db.tripSync.get(tripId)
      if (r) await this.db.tripSync.put({ ...r, localOnly: false, state: 'dirty', serverRevision: 0, localVersion: r.localVersion + 1 })
    })
  }

  /** 清除本设备上属于账号的数据（「仅本设备」的行程保留），并解除关联 */
  async clearAccountData(): Promise<void> {
    await this.tx(async () => {
      for (const r of await this.db.tripSync.toArray()) {
        if (r.localOnly) continue
        await this.db.legs.where('tripId').equals(r.tripId).delete()
        await this.db.referencedAirports.where('tripId').equals(r.tripId).delete()
        await this.db.trips.delete(r.tripId)
        await this.db.tripSync.delete(r.tripId)
      }
      await this.db.pendingDeletes.clear()
      await this.db.syncMeta.delete('account')
    })
  }

  /** 解除关联但保留数据：所有行程变为未上传的本地行程 */
  async detachKeepData(): Promise<void> {
    await this.tx(async () => {
      for (const r of await this.db.tripSync.toArray()) {
        if (!r.localOnly) await this.db.tripSync.put({ ...r, state: 'dirty', serverRevision: 0, error: undefined, localVersion: r.localVersion + 1 })
      }
      await this.db.pendingDeletes.clear()
      await this.db.syncMeta.delete('account')
    })
  }
}
