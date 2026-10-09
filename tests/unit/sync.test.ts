import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clone, create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { TripBundleSchema, TripSchema, type TripBundle } from '@/gen/neomap/v1/trip_pb'
import { HolidayDb } from '@/lib/db'
import { TripRepository } from '@/lib/repositories/tripRepository'
import { SyncStore } from '@/lib/sync/syncStore'
import { SyncAuthError, SyncEngine, SyncOfflineError, type TripApi } from '@/lib/sync/engine'
import { fromProto, sameContent, toProto } from '@/lib/sync/convert'
import type { Airport } from '@/types'
import fixtures from '../fixtures/airports.json'

const A = fixtures as Record<string, Airport>

/** 按服务端协议实现的内存假服务（版本、墓碑、变更序号、冲突详情、ID 归属） */
class FakeServer {
  trips = new Map<string, { owner: string; bundle: TripBundle; revision: number; seq: number; deleted: boolean }>()
  seq = 0
  horizon = new Map<string, number>()
  failNext: Error | null = null

  private take() {
    const e = this.failNext
    this.failNext = null
    if (e) throw e
  }

  private view(id: string): TripBundle {
    const t = this.trips.get(id)!
    if (t.deleted) return create(TripBundleSchema, { trip: create(TripSchema, { id }), revision: BigInt(t.revision), deleted: true })
    const b = clone(TripBundleSchema, t.bundle)
    b.revision = BigInt(t.revision)
    return b
  }

  private conflict(id: string) {
    return new ConnectError('conflict', Code.Aborted, undefined, [{ desc: TripBundleSchema, value: this.view(id) }])
  }

  client(userId: string, hooks: { beforePutReturns?: () => Promise<void> } = {}): TripApi {
    return {
      listChanges: async (cursor, pageSize) => {
        this.take()
        const after = cursor ? Number(cursor.slice(3)) : 0
        if (after > 0 && after < (this.horizon.get(userId) ?? 0)) throw new ConnectError('expired', Code.FailedPrecondition)
        const all = [...this.trips.entries()].filter(([, t]) => t.owner === userId && t.seq > after).sort((x, y) => x[1].seq - y[1].seq)
        const page = all.slice(0, pageSize)
        const last = page.at(-1)?.[1].seq ?? after
        return { trips: page.map(([id]) => this.view(id)), nextCursor: `c1.${last}`, hasMore: all.length > pageSize }
      },
      putTrip: async (bundle, base) => {
        this.take()
        const id = bundle.trip!.id
        const cur = this.trips.get(id)
        // 航段 ID 全局唯一
        for (const [tid, t] of this.trips) {
          if (tid !== id && !t.deleted && t.bundle.legs.some((l) => bundle.legs.some((x) => x.id === l.id))) throw new ConnectError('taken', Code.AlreadyExists)
        }
        if (!cur) {
          if (base !== 0) throw new ConnectError('not found', Code.NotFound)
        } else if (cur.owner !== userId) {
          throw new ConnectError('taken', Code.AlreadyExists)
        } else if (cur.revision !== base) {
          if (!cur.deleted && sameContent(fromProto(cur.bundle), fromProto(bundle))) return this.view(id)
          throw this.conflict(id)
        }
        this.trips.set(id, { owner: userId, bundle: clone(TripBundleSchema, bundle), revision: (cur?.revision ?? 0) + 1, seq: ++this.seq, deleted: false })
        const out = this.view(id)
        await hooks.beforePutReturns?.()
        return out
      },
      deleteTrip: async (id, base) => {
        this.take()
        const cur = this.trips.get(id)
        if (!cur || cur.owner !== userId) throw new ConnectError('not found', Code.NotFound)
        if (cur.revision !== base) {
          if (cur.deleted) return cur.revision
          throw this.conflict(id)
        }
        this.trips.set(id, { ...cur, revision: cur.revision + 1, seq: ++this.seq, deleted: true })
        return cur.revision + 1
      },
    }
  }

  /** 物理清理墓碑，提高用户的游标水位 */
  purge(userId: string) {
    for (const [id, t] of this.trips) {
      if (t.owner === userId && t.deleted) {
        this.horizon.set(userId, Math.max(this.horizon.get(userId) ?? 0, t.seq))
        this.trips.delete(id)
      }
    }
  }
}

class Device {
  db = new HolidayDb(`sync-${crypto.randomUUID()}`)
  repo = new TripRepository(this.db)
  store = new SyncStore(this.db)
  engine: SyncEngine
  constructor(server: FakeServer, userId = 'u1', hooks: Parameters<FakeServer['client']>[1] = {}) {
    this.engine = new SyncEngine(this.store, server.client(userId, hooks))
  }
  async link(userId = 'u1') {
    await this.store.linkAccount(userId, 'Tester')
  }
  sync() {
    return this.engine.run()
  }
  async titles() {
    return (await this.repo.listTrips()).map((t) => t.title).sort()
  }
  async record(tripId: string) {
    return this.store.getRecord(tripId)
  }
}

async function makeTrip(d: Device, title = '亚洲假期') {
  const trip = await d.repo.createTrip({ title, startDate: '2026-09-26' })
  await d.repo.addLeg(trip.id, { departure: A.YNZ, arrival: A.ICN, departureDate: '2026-09-26' })
  await d.repo.addLeg(trip.id, { departure: A.ICN, arrival: A.HKT, departureDate: '2026-09-27' })
  return trip.id
}

let server: FakeServer
let a: Device
let b: Device

beforeEach(async () => {
  server = new FakeServer()
  a = new Device(server)
  b = new Device(server)
  await a.repo.open()
  await b.repo.open()
  await a.link()
  await b.link()
})

describe('convert', () => {
  it('本地 → proto → 本地 往返不丢信息', async () => {
    const id = await makeTrip(a)
    const local = (await a.store.readBundle(id))!
    const back = fromProto(toProto(local))
    expect(sameContent(local, back)).toBe(true)
    expect(back.legs.map((l) => l.order)).toEqual([0, 1])
    expect(back.airports.find((x) => x.iata === 'ICN')?.key).toBe(`${id}:${A.ICN.id}`)
  })
})

describe('SyncEngine', () => {
  it('新建 → 上传 → 另一设备拉取得到相同内容', async () => {
    const id = await makeTrip(a)
    const r = await a.sync()
    expect(r.pushed).toBe(1)
    expect((await a.record(id))?.state).toBe('synced')

    const rb = await b.sync()
    expect(rb.pulled).toBe(1)
    expect(sameContent((await a.store.readBundle(id))!, (await b.store.readBundle(id))!)).toBe(true)
    expect((await b.record(id))?.state).toBe('synced')

    // 再次同步没有任何变化
    const again = await a.sync()
    expect([again.pushed, again.pulled]).toEqual([0, 0])
  })

  it('修改与删除在设备间传播', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await b.sync()
    await a.repo.updateTrip(id, { title: '改名了' })
    await a.sync()
    await b.sync()
    expect(await b.titles()).toEqual(['改名了'])

    await b.repo.deleteTrip(id)
    expect(await b.store.getPendingDelete(id)).toBeTruthy()
    await b.sync()
    expect(server.trips.get(id)?.deleted).toBe(true)
    const ra = await a.sync()
    expect(ra.deletedRemotely).toBe(1)
    expect(await a.titles()).toEqual([])
  })

  it('两端同时修改：服务端版本为准，本地修改另存为副本，不丢数据', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await b.sync()
    await a.repo.updateTrip(id, { title: 'A 的修改' })
    await b.repo.updateTrip(id, { title: 'B 的修改' })
    await a.sync()
    const rb = await b.sync()
    expect(rb.conflicts).toEqual(['B 的修改'])
    expect(await b.titles()).toEqual(['A 的修改', 'B 的修改（本设备副本）'])
    // 副本已上传，A 下次同步也能看到
    await a.sync()
    expect(await a.titles()).toEqual(['A 的修改', 'B 的修改（本设备副本）'])
  })

  it('两端改成相同内容：不产生副本', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await b.sync()
    const same = (await a.store.readBundle(id))!
    // 两端写入完全相同的内容（含时间戳）
    for (const d of [a, b]) {
      await d.store.applyServer({ ...same, trip: { ...same.trip, title: '一样' } }, (await d.record(id))!.serverRevision)
      await d.db.tripSync.update(id, { state: 'dirty' })
    }
    await a.sync()
    const rb = await b.sync()
    expect(rb.conflicts).toEqual([])
    expect(await b.titles()).toEqual(['一样'])
  })

  it('本地删除、其他设备之后又修改：删除不生效，保留修改', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await b.sync()
    await a.repo.deleteTrip(id)
    await b.repo.updateTrip(id, { title: 'B 后来改了' })
    await b.sync()
    const ra = await a.sync()
    expect(ra.deletesOverridden).toEqual(['B 后来改了'])
    expect(await a.titles()).toEqual(['B 后来改了'])
    expect(await a.store.getPendingDelete(id)).toBeUndefined()
  })

  it('本地修改、其他设备已删除：本地内容另存为新行程', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await b.sync()
    await b.repo.deleteTrip(id)
    await b.sync()
    await a.repo.updateTrip(id, { title: 'A 还在改' })
    const ra = await a.sync()
    expect(ra.conflicts).toEqual(['A 还在改'])
    expect(await a.titles()).toEqual(['A 还在改（本设备副本）'])
    expect(await a.db.trips.get(id)).toBeUndefined()
    await b.sync()
    expect(await b.titles()).toEqual(['A 还在改（本设备副本）'])
  })

  it('上传期间又被修改：上传成功后仍为待同步，下次带新版本上传', async () => {
    let edit = async () => {}
    const c = new Device(server, 'u1', { beforePutReturns: () => edit() })
    await c.repo.open()
    await c.link()
    const id = await makeTrip(c)
    edit = async () => {
      edit = async () => {}
      await c.repo.updateTrip(id, { title: '上传中修改' })
    }
    await c.sync()
    expect((await c.record(id))?.state).toBe('dirty')
    expect((await c.record(id))?.serverRevision).toBe(1)
    await c.sync()
    expect((await c.record(id))?.state).toBe('synced')
    expect(server.trips.get(id)?.bundle.trip?.title).toBe('上传中修改')
  })

  it('上传期间被删除：删除基于新版本，不会被误判为冲突而复活', async () => {
    let hook = async () => {}
    const c = new Device(server, 'u1', { beforePutReturns: () => hook() })
    await c.repo.open()
    await c.link()
    const id = await makeTrip(c)
    await c.sync()
    await c.repo.updateTrip(id, { title: '再改一次' })
    hook = async () => {
      hook = async () => {}
      await c.repo.deleteTrip(id)
    }
    await c.sync()
    expect(server.trips.get(id)?.deleted).toBe(true)
    expect(await c.titles()).toEqual([])
  })

  it('行程 ID 被其他账号占用：换新 ID 上传，并报告 ID 映射', async () => {
    const other = new Device(server, 'u2')
    await other.repo.open()
    await other.link('u2')
    const id = await makeTrip(a)
    await a.sync()
    // u2 的设备上恰好有同 ID 的行程（例如导入了同一份备份）
    const local = (await a.store.readBundle(id))!
    await other.store.applyServer(local, 0)
    await other.db.tripSync.update(id, { state: 'dirty', serverRevision: 0 })
    const r = await other.sync()
    const newId = r.renamed.get(id)
    expect(newId).toBeTruthy()
    expect(server.trips.get(newId!)?.owner).toBe('u2')
    expect(await other.db.trips.get(id)).toBeUndefined()
  })

  it('游标过期：全量重新拉取，删除服务端已清理的行程', async () => {
    const keep = await makeTrip(a, '保留')
    const gone = await makeTrip(a, '已删除')
    await a.sync()
    await b.sync()
    await a.repo.updateTrip(keep, { title: '保留（已改）' })
    await a.repo.deleteTrip(gone)
    await a.sync()
    server.purge('u1')
    const rb = await b.sync()
    expect(rb.deletedRemotely).toBe(1)
    expect(await b.titles()).toEqual(['保留（已改）'])
  })

  it('服务端拒绝（校验失败）：标记错误，不阻塞其他行程，再次修改后重试', async () => {
    const bad = await makeTrip(a, '会被拒绝')
    const good = await makeTrip(a, '正常')
    const api = server.client('u1')
    const engine = new SyncEngine(a.store, {
      ...api,
      putTrip: (bundle, base) => (bundle.trip?.id === bad ? Promise.reject(new ConnectError('标题不合法', Code.InvalidArgument)) : api.putTrip(bundle, base)),
    })
    const r = await engine.run()
    expect(r.rejected).toEqual([{ title: '会被拒绝', message: '标题不合法' }])
    expect((await a.record(bad))?.state).toBe('error')
    expect((await a.record(good))?.state).toBe('synced')
    await a.repo.updateTrip(bad, { title: '改好了' })
    expect((await a.record(bad))?.state).toBe('dirty')
    await a.sync()
    expect((await a.record(bad))?.state).toBe('synced')
  })

  it('网络错误与会话失效：中断同步，本地修改保留', async () => {
    const id = await makeTrip(a)
    server.failNext = new ConnectError('offline', Code.Unavailable)
    await expect(a.sync()).rejects.toBeInstanceOf(SyncOfflineError)
    expect((await a.record(id))?.state).toBe('dirty')
    server.failNext = new ConnectError('login', Code.Unauthenticated)
    await expect(a.sync()).rejects.toBeInstanceOf(SyncAuthError)
    await a.sync()
    expect((await a.record(id))?.state).toBe('synced')
  })

  it('「仅本设备」的行程不上传；改为上传后正常同步', async () => {
    const id = await makeTrip(a)
    await a.store.markNeverUploadedLocalOnly()
    await a.sync()
    expect(server.trips.size).toBe(0)
    await a.repo.updateTrip(id, { title: '仍只在本设备' })
    await a.sync()
    expect(server.trips.size).toBe(0)
    await a.store.uploadLocalOnly(id)
    await a.sync()
    expect(server.trips.get(id)?.bundle.trip?.title).toBe('仍只在本设备')
  })

  it('未关联账号时不同步', async () => {
    const c = new Device(server)
    await c.repo.open()
    await makeTrip(c)
    const r = await c.sync()
    expect(r.pushed).toBe(0)
    expect(server.trips.size).toBe(0)
  })
})

describe('账号切换与退出', () => {
  it('清除账号数据时保留「仅本设备」的行程', async () => {
    const synced = await makeTrip(a, '账号行程')
    await a.sync()
    const local = await makeTrip(a, '只在本设备')
    await a.store.markNeverUploadedLocalOnly()
    expect((await a.record(synced))?.localOnly).toBe(false)
    await a.store.clearAccountData()
    expect(await a.titles()).toEqual(['只在本设备'])
    expect(await a.store.getAccount()).toBeUndefined()
    expect((await a.record(local))?.localOnly).toBe(true)
  })

  it('解除关联但保留数据：行程变为未上传', async () => {
    const id = await makeTrip(a)
    await a.sync()
    await a.repo.deleteTrip(await makeTrip(a, '待删'))
    await a.store.detachKeepData()
    expect(await a.store.getAccount()).toBeUndefined()
    expect(await a.record(id)).toMatchObject({ state: 'dirty', serverRevision: 0 })
    expect(await a.store.listPendingDeletes()).toEqual([])
    expect(await a.store.neverUploadedCount()).toBe(1)
  })

  it('数据库升级：v1 中已有的行程被标记为待上传', async () => {
    const name = `upgrade-${crypto.randomUUID()}`
    const { default: Dexie } = await import('dexie')
    const v1 = new Dexie(name)
    v1.version(1).stores({ trips: 'id, createdAt', legs: 'id, tripId, [tripId+order]', referencedAirports: 'key, tripId' })
    await v1.open()
    await v1.table('trips').add({ id: 't-old', title: '旧数据', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    v1.close()
    const db = new HolidayDb(name)
    await db.open()
    expect(await db.tripSync.get('t-old')).toMatchObject({ state: 'dirty', serverRevision: 0, localOnly: false })
  })
})
