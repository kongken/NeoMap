import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { getDb } from '@/lib/db'
import { tripClient } from '@/lib/api/client'
import { createTripApi } from '@/lib/sync/api'
import { SyncAuthError, SyncEngine, SyncOfflineError, type SyncReport } from '@/lib/sync/engine'
import { SyncStore } from '@/lib/sync/syncStore'
import type { SyncAccount, TripSyncRecord } from '@/lib/sync/types'
import { useAppData } from '@/app/AppDataContext'
import { useAuth } from '@/features/auth/AuthContext'

export type SyncStatus =
  /** 未配置后端或未关联账号 */
  | { kind: 'inactive' }
  /** 本设备数据关联了账号，但当前未登录：修改会在登录后上传 */
  | { kind: 'signed-out' }
  /** 等待用户在对话框中做出选择 */
  | { kind: 'awaiting-decision' }
  | { kind: 'syncing' }
  | { kind: 'idle'; lastSyncedAt?: string }
  | { kind: 'offline' }

export type SyncDecision =
  | { type: 'first-login'; count: number; displayName: string }
  | { type: 'switch-account'; from: SyncAccount; unsynced: number; displayName: string }
  | { type: 'logout'; allDevices: boolean; account: SyncAccount; tripCount: number; unsynced: number }

export interface PendingCounts {
  dirty: number
  errors: number
  deletes: number
  localOnly: number
}

interface SyncContextValue {
  status: SyncStatus
  counts: PendingCounts
  records: Map<string, TripSyncRecord>
  account: SyncAccount | null
  decision: SyncDecision | null
  syncNow: () => void
  resolveFirstLogin: (upload: boolean) => Promise<void>
  resolveSwitch: (choice: 'clear' | 'keep' | 'cancel') => Promise<void>
  /** 退出登录：已关联账号时先询问如何处理本设备上的数据 */
  requestLogout: (allDevices: boolean) => Promise<void>
  resolveLogout: (choice: 'clear' | 'keep' | 'cancel') => Promise<void>
  uploadLocalOnly: (tripId: string) => Promise<void>
}

const Ctx = createContext<SyncContextValue | null>(null)
const EMPTY_COUNTS: PendingCounts = { dirty: 0, errors: 0, deletes: 0, localOnly: 0 }
const DEBOUNCE_MS = 2000
const INTERVAL_MS = 5 * 60 * 1000

function announce(r: SyncReport) {
  for (const title of r.conflicts) toast.warning(`「${title}」在其他设备上被修改，本设备的修改已另存为副本`)
  for (const title of r.deletesOverridden) toast.info(`「${title}」已在其他设备上修改，本设备的删除未生效`)
  for (const { title, message } of r.rejected) toast.error(`「${title}」无法同步：${message}`)
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const data = useAppData()
  const auth = useAuth()
  // 上下文对象每次渲染都会变化：通过 ref 读取，保持回调稳定，避免 effect 反复触发同步
  const dataRef = useRef(data)
  const authRef = useRef(auth)
  useEffect(() => {
    dataRef.current = data
    authRef.current = auth
  })
  const store = useMemo(() => new SyncStore(getDb()), [])
  const engine = useMemo(() => (tripClient ? new SyncEngine(store, createTripApi(tripClient)) : null), [store])

  const [status, setStatus] = useState<SyncStatus>({ kind: 'inactive' })
  const [counts, setCounts] = useState<PendingCounts>(EMPTY_COUNTS)
  const [records, setRecords] = useState<Map<string, TripSyncRecord>>(new Map())
  const [account, setAccount] = useState<SyncAccount | null>(null)
  const [decision, setDecision] = useState<SyncDecision | null>(null)

  const running = useRef(false)
  const rerun = useRef(false)
  /** 已登录、已关联且与当前账号一致、没有待决定的对话框时才同步 */
  const active = useRef(false)
  const userId = auth.state.status === 'authenticated' ? auth.state.user.id : null
  const displayName = auth.state.status === 'authenticated' ? auth.state.user.displayName : ''

  const refreshLocalState = useCallback(async () => {
    const [c, recs, acc] = await Promise.all([store.pendingCounts(), store.listRecords(), store.getAccount()])
    setCounts(c)
    setRecords(new Map(recs.map((r) => [r.tripId, r])))
    setAccount(acc ?? null)
  }, [store])

  const runSync = useCallback(async () => {
    if (!engine || !active.current) return
    if (running.current) {
      rerun.current = true
      return
    }
    running.current = true
    setStatus({ kind: 'syncing' })
    try {
      do {
        rerun.current = false
        const report = await engine.run()
        announce(report)
        const changed = report.pulled + report.conflicts.length + report.deletedRemotely + report.deletesOverridden.length + report.renamed.size > 0
        if (changed) await dataRef.current.refreshFromStorage(report.renamed)
      } while (rerun.current && active.current)
      const acc = await store.getAccount()
      setStatus({ kind: 'idle', lastSyncedAt: acc?.lastSyncedAt })
    } catch (err) {
      if (err instanceof SyncAuthError) {
        active.current = false
        toast.error('登录已失效，请重新登录以继续同步')
        await authRef.current.refresh()
      } else if (err instanceof SyncOfflineError) {
        setStatus({ kind: 'offline' })
      } else {
        setStatus({ kind: 'offline' })
        console.error('sync failed', err)
      }
    } finally {
      running.current = false
      await refreshLocalState()
    }
  }, [engine, store, refreshLocalState])

  // 登录状态变化：决定是否关联账号、是否需要用户选择
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const acc = await store.getAccount()
      if (cancelled) return
      if (!engine || !userId) {
        active.current = false
        setDecision((d) => (d?.type === 'logout' ? d : null))
        setStatus(acc && engine ? { kind: 'signed-out' } : { kind: 'inactive' })
        await refreshLocalState()
        return
      }
      if (!acc) {
        const count = await store.neverUploadedCount()
        if (count === 0) {
          await store.linkAccount(userId, displayName)
          active.current = true
          void runSync()
        } else {
          active.current = false
          setStatus({ kind: 'awaiting-decision' })
          setDecision({ type: 'first-login', count, displayName })
        }
      } else if (acc.userId === userId) {
        if (acc.displayName !== displayName) await store.renameAccount(displayName)
        active.current = true
        void runSync()
      } else {
        const c = await store.pendingCounts()
        active.current = false
        setStatus({ kind: 'awaiting-decision' })
        setDecision({ type: 'switch-account', from: acc, unsynced: c.dirty + c.errors + c.deletes, displayName })
      }
      await refreshLocalState()
    })()
    return () => {
      cancelled = true
    }
  }, [engine, store, userId, displayName, runSync, refreshLocalState])

  // 触发同步：本地修改后防抖、回到前台、恢复网络、定时
  useEffect(() => {
    if (!engine) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = dataRef.current.subscribeLocalChanges(() => {
      void refreshLocalState()
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void runSync(), DEBOUNCE_MS)
    })
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runSync()
    }
    const onOnline = () => void runSync()
    const interval = setInterval(() => void runSync(), INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [engine, runSync, refreshLocalState])

  const resolveFirstLogin = useCallback(
    async (upload: boolean) => {
      if (!userId) return
      if (!upload) await store.markNeverUploadedLocalOnly()
      await store.linkAccount(userId, displayName)
      setDecision(null)
      active.current = true
      await refreshLocalState()
      if (upload) toast.success('正在上传本设备上的假期')
      void runSync()
    },
    [store, userId, displayName, runSync, refreshLocalState],
  )

  const resolveSwitch = useCallback(
    async (choice: 'clear' | 'keep' | 'cancel') => {
      if (choice === 'cancel') {
        setDecision(null)
        await authRef.current.logout(false)
        return
      }
      if (choice === 'clear') await store.clearAccountData()
      else await store.detachKeepData()
      await dataRef.current.refreshFromStorage()
      setDecision(null)
      // 重新走一遍关联流程（保留的数据会询问是否上传到新账号）
      const count = await store.neverUploadedCount()
      if (userId && count > 0) {
        setDecision({ type: 'first-login', count, displayName })
      } else if (userId) {
        await store.linkAccount(userId, displayName)
        active.current = true
        void runSync()
      }
      await refreshLocalState()
    },
    [store, userId, displayName, runSync, refreshLocalState],
  )

  const requestLogout = useCallback(
    async (allDevices: boolean) => {
      const acc = await store.getAccount()
      if (!acc) {
        await authRef.current.logout(allDevices)
        return
      }
      const c = await store.pendingCounts()
      const tripCount = (await store.listRecords()).filter((r) => !r.localOnly).length
      setDecision({ type: 'logout', allDevices, account: acc, tripCount, unsynced: c.dirty + c.errors + c.deletes })
    },
    [store],
  )

  const resolveLogout = useCallback(
    async (choice: 'clear' | 'keep' | 'cancel') => {
      const d = decision
      setDecision(null)
      if (choice === 'cancel' || d?.type !== 'logout') return
      active.current = false
      await authRef.current.logout(d.allDevices)
      if (choice === 'clear') await store.clearAccountData()
      else await store.detachKeepData()
      await dataRef.current.refreshFromStorage()
      await refreshLocalState()
      setStatus({ kind: 'inactive' })
    },
    [decision, store, refreshLocalState],
  )

  const uploadLocalOnly = useCallback(
    async (tripId: string) => {
      await store.uploadLocalOnly(tripId)
      await refreshLocalState()
      void runSync()
    },
    [store, runSync, refreshLocalState],
  )

  const value: SyncContextValue = {
    status,
    counts,
    records,
    account,
    decision,
    syncNow: () => void runSync(),
    resolveFirstLogin,
    resolveSwitch,
    requestLogout,
    resolveLogout,
    uploadLocalOnly,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSync(): SyncContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSync must be used within SyncProvider')
  return v
}
