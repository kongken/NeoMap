/** 本地云同步状态的存储类型。协议见 docs/backend-phase1-design.md 第 6 节。 */

export type TripSyncState =
  /** 本地有未上传的修改 */
  | 'dirty'
  /** 与服务端 serverRevision 一致 */
  | 'synced'
  /** 服务端拒绝（校验失败、数量上限）；用户再次修改后会重试 */
  | 'error'

export interface TripSyncRecord {
  tripId: string
  state: TripSyncState
  /** 本地所知的服务端版本；0 表示服务端还没有这个行程 */
  serverRevision: number
  /** 「仅本设备」：首次登录时用户选择不上传，不参与同步 */
  localOnly: boolean
  /** 本地修改计数：上传期间又被修改时，上传成功后仍保持 dirty */
  localVersion: number
  error?: string
}

export interface PendingDelete {
  tripId: string
  serverRevision: number
}

export interface SyncAccount {
  key: 'account'
  /** 本设备数据关联的账号 */
  userId: string
  displayName: string
  /** ListChanges 游标；空表示需要全量拉取 */
  cursor: string
  lastSyncedAt?: string
}
