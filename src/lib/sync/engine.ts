import { Code, ConnectError } from '@connectrpc/connect'
import { TripBundleSchema, type TripBundle } from '@/gen/neomap/v1/trip_pb'
import { copyTitle, fromProto, sameContent, toProto } from './convert'
import type { SyncStore } from './syncStore'

/** 引擎依赖的服务端接口（真实实现基于 TripService 客户端，测试中用内存实现） */
export interface TripApi {
  listChanges(cursor: string, pageSize: number): Promise<{ trips: TripBundle[]; nextCursor: string; hasMore: boolean }>
  putTrip(bundle: TripBundle, baseRevision: number): Promise<TripBundle>
  deleteTrip(tripId: string, baseRevision: number): Promise<number>
}

/** 同步中断：会话失效，需要重新登录 */
export class SyncAuthError extends Error {
  constructor() {
    super('登录已失效，请重新登录')
  }
}

/** 同步中断：网络或服务不可用，稍后自动重试 */
export class SyncOfflineError extends Error {}

export interface SyncReport {
  pushed: number
  pulled: number
  /** 两端都修改过：服务端版本为准，本地修改另存为副本（标题） */
  conflicts: string[]
  /** 本地删除了，但其他设备之后又修改过：删除未生效（标题） */
  deletesOverridden: string[]
  /** 其他设备删除的行程数量 */
  deletedRemotely: number
  /** 服务端拒绝的行程（标题、原因） */
  rejected: { title: string; message: string }[]
  /** 行程 ID 被替换（旧 ID → 新 ID），用于保持界面上的选中状态 */
  renamed: Map<string, string>
}

const PAGE_SIZE = 200

const revisionOf = (b: TripBundle) => Number(b.revision)

function conflictDetail(err: ConnectError): TripBundle | undefined {
  return err.findDetails(TripBundleSchema)[0]
}

/** 不属于单个行程的错误：会话失效或网络问题，中断本次同步 */
function fatal(err: unknown): Error {
  const e = ConnectError.from(err)
  if (e.code === Code.Unauthenticated) return new SyncAuthError()
  return new SyncOfflineError(e.rawMessage || '网络不可用')
}

/**
 * 云同步引擎：推送本地修改 → 增量拉取服务端变更。
 * 冲突时以服务端为准，本地修改另存为副本，不丢数据。协议见设计文档第 6 节。
 */
export class SyncEngine {
  private readonly store: SyncStore
  private readonly api: TripApi

  constructor(store: SyncStore, api: TripApi) {
    this.store = store
    this.api = api
  }

  async run(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, pulled: 0, conflicts: [], deletesOverridden: [], deletedRemotely: 0, rejected: [], renamed: new Map() }
    if (!(await this.store.getAccount())) return report

    // 再推一轮的情况：ID 被占用换了新 ID、服务端已不存在改为新建、上传期间又有行程被删除
    for (let round = 0; round < 3; round++) {
      await this.pushDeletes(report)
      const again = await this.pushDirty(report)
      const newDeletes = (await this.store.listPendingDeletes()).length > 0
      if (!again && !newDeletes) break
    }
    const needsRepush = await this.pull(report)
    if (needsRepush) await this.pushDirty(report)
    await this.store.setLastSynced(new Date().toISOString())
    return report
  }

  private async pushDeletes(report: SyncReport): Promise<void> {
    for (const pd of await this.store.listPendingDeletes()) {
      try {
        await this.api.deleteTrip(pd.tripId, pd.serverRevision)
        await this.store.removePendingDelete(pd.tripId)
      } catch (err) {
        const e = ConnectError.from(err)
        if (e.code === Code.NotFound) {
          await this.store.removePendingDelete(pd.tripId)
        } else if (e.code === Code.Aborted) {
          const current = conflictDetail(e)
          if (current && !current.deleted) {
            // 其他设备在本地删除之后修改过：保留服务端版本，删除不生效
            await this.store.applyServer(fromProto(current), revisionOf(current))
            report.deletesOverridden.push(current.trip?.title ?? '')
          } else {
            await this.store.removePendingDelete(pd.tripId)
          }
        } else {
          throw fatal(err)
        }
      }
    }
  }

  /** 推送有本地修改的行程；返回是否需要再推一轮 */
  private async pushDirty(report: SyncReport): Promise<boolean> {
    let again = false
    for (const rec of await this.store.dirtyRecords()) {
      const snap = await this.store.readForPush(rec.tripId)
      if (!snap) continue
      const { bundle, localVersion } = snap
      try {
        const saved = await this.api.putTrip(toProto(bundle), rec.serverRevision)
        await this.store.markPushed(rec.tripId, revisionOf(saved), localVersion)
        report.pushed++
      } catch (err) {
        const e = ConnectError.from(err)
        switch (e.code) {
          case Code.Aborted: {
            const current = conflictDetail(e)
            if (!current) break // 下一步拉取时再处理
            if (current.deleted) {
              // 其他设备已删除，本设备又修改过：本地内容另存为新行程
              await this.store.saveAsNew(bundle, copyTitle(bundle.trip.title))
              await this.store.deleteLocal(rec.tripId)
              report.conflicts.push(bundle.trip.title)
              again = true
            } else {
              const server = fromProto(current)
              if (!sameContent(bundle, server)) {
                await this.store.saveAsNew(bundle, copyTitle(bundle.trip.title))
                report.conflicts.push(bundle.trip.title)
                again = true
              }
              await this.store.applyServer(server, revisionOf(current))
            }
            break
          }
          case Code.AlreadyExists: {
            // 行程或航段 ID 已被其他账号 / 行程使用：换新 ID 重新上传
            const newId = await this.store.saveAsNew(bundle, bundle.trip.title)
            await this.store.deleteLocal(rec.tripId)
            report.renamed.set(rec.tripId, newId)
            again = true
            break
          }
          case Code.NotFound:
            // 服务端已没有该行程（墓碑已清理）：改为新建
            await this.store.setServerRevision(rec.tripId, 0)
            again = true
            break
          case Code.InvalidArgument:
          case Code.ResourceExhausted: {
            const message = e.code === Code.ResourceExhausted ? '行程数量已达上限或内容过大' : e.rawMessage
            await this.store.markError(rec.tripId, message)
            report.rejected.push({ title: bundle.trip.title, message })
            break
          }
          default:
            throw fatal(err)
        }
      }
    }
    return again
  }

  /** 增量拉取并应用；返回是否产生了需要上传的内容 */
  private async pull(report: SyncReport): Promise<boolean> {
    const account = (await this.store.getAccount())!
    let cursor = account.cursor
    let full = cursor === ''
    const seen = new Set<string>()
    let needsPush = false

    for (let page = 0; page < 10_000; page++) {
      let res
      try {
        res = await this.api.listChanges(cursor, PAGE_SIZE)
      } catch (err) {
        if (ConnectError.from(err).code === Code.FailedPrecondition) {
          // 游标过期（墓碑已清理）：全量重新拉取
          cursor = ''
          full = true
          seen.clear()
          continue
        }
        throw fatal(err)
      }
      for (const b of res.trips) {
        const id = b.trip!.id
        seen.add(id)
        if (await this.applyPulled(b, report)) needsPush = true
      }
      cursor = res.nextCursor
      await this.store.saveCursor(cursor)
      if (!res.hasMore) break
    }

    if (full) {
      const { removed, recreate } = await this.store.reconcileAfterFullSync(seen)
      report.deletedRemotely += removed
      if (recreate > 0) needsPush = true
    }
    return needsPush
  }

  /** 应用一个拉取到的行程；返回是否产生了待上传的本地副本 */
  private async applyPulled(b: TripBundle, report: SyncReport): Promise<boolean> {
    const id = b.trip!.id
    const rev = revisionOf(b)
    const rec = await this.store.getRecord(id)
    const pd = await this.store.getPendingDelete(id)
    if (rec?.localOnly) return false

    if (b.deleted) {
      if (pd) {
        await this.store.removePendingDelete(id) // 两端都删除了
        return false
      }
      if (!rec || rec.serverRevision >= rev) return false
      let copied = false
      if (rec.state !== 'synced') {
        // 本设备修改过、其他设备删除了：本地内容另存为新行程
        const local = await this.store.readBundle(id)
        if (local) {
          await this.store.saveAsNew(local, copyTitle(local.trip.title))
          report.conflicts.push(local.trip.title)
          copied = true
        }
      }
      await this.store.deleteLocal(id)
      report.deletedRemotely++
      return copied
    }

    const server = fromProto(b)
    if (pd) {
      if (rev > pd.serverRevision) {
        // 本地删除后其他设备又修改过：保留服务端版本
        await this.store.applyServer(server, rev)
        report.deletesOverridden.push(server.trip.title)
        report.pulled++
      }
      return false
    }
    if (rec && rec.serverRevision >= rev) return false // 本设备自己的写入，已是最新

    let copied = false
    if (rec && rec.state !== 'synced') {
      const local = await this.store.readBundle(id)
      if (local && !sameContent(local, server)) {
        await this.store.saveAsNew(local, copyTitle(local.trip.title))
        report.conflicts.push(local.trip.title)
        copied = true
      }
    }
    await this.store.applyServer(server, rev)
    report.pulled++
    return copied
  }
}
