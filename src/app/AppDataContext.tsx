import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Airport, BackupV1, Trip } from '@/types'
import { getDb } from '@/lib/db'
import { TripRepository, type LegInput, type TripBundle, type TripInput } from '@/lib/repositories/tripRepository'
import { loadAirportCatalog, type AirportCatalog } from '@/lib/airports/catalog'
import type { ImportPlan } from '@/lib/backup/backup'
import { SAMPLE_TRIP } from '@/features/trips/sampleTrip'

type Status = 'loading' | 'ready' | 'error'

interface AppData {
  status: Status
  storageError: string | null
  retryStorage: () => void
  trips: Trip[]
  currentTripId: string | null
  bundle: TripBundle | null
  airportsById: Map<string, Airport>
  selectTrip: (id: string | null) => void
  catalog: AirportCatalog | null
  catalogError: string | null
  retryCatalog: () => void
  /** 视野适配请求序号：创建/切换假期或用户点击重置时递增 */
  fitRequest: number
  requestFit: () => void

  createTrip: (input: TripInput) => Promise<Trip>
  updateTrip: (id: string, input: TripInput) => Promise<void>
  deleteTrip: (id: string) => Promise<void>
  addLeg: (input: LegInput) => Promise<void>
  updateLeg: (legId: string, input: LegInput) => Promise<void>
  deleteLeg: (legId: string) => Promise<void>
  moveLeg: (legId: string, dir: -1 | 1) => Promise<void>
  loadSample: () => Promise<void>
  exportBackup: () => Promise<BackupV1>
  planImport: (backup: BackupV1) => ImportPlan
  findDuplicateTrips: (backup: BackupV1) => Promise<string[]>
  applyImport: (plan: ImportPlan) => Promise<void>
  /** 订阅本地数据变更（云同步用于防抖触发） */
  subscribeLocalChanges: (fn: () => void) => () => void
  /**
   * 重新从本地存储读取（云同步写入之后调用）。renamed 为行程 ID 映射，
   * 当前查看的行程被换了 ID 时保持选中；当前行程被删除时切换到其他行程。
   */
  refreshFromStorage: (renamed?: Map<string, string>) => Promise<void>
}

const Ctx = createContext<AppData | null>(null)
const LAST_TRIP_KEY = 'hfm:lastTripId'

function readLastTrip(): string | null {
  try {
    return localStorage.getItem(LAST_TRIP_KEY)
  } catch {
    return null
  }
}
function writeLastTrip(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_TRIP_KEY, id)
    else localStorage.removeItem(LAST_TRIP_KEY)
  } catch {
    /* 忽略：仅用于记住上次查看的假期 */
  }
}

const describeError = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function AppDataProvider({ children }: { children: ReactNode }) {
  const repo = useMemo(() => new TripRepository(getDb()), [])
  const [status, setStatus] = useState<Status>('loading')
  const [storageError, setStorageError] = useState<string | null>(null)
  const [storageAttempt, setStorageAttempt] = useState(0)
  const [trips, setTrips] = useState<Trip[]>([])
  const [currentTripId, setCurrentTripId] = useState<string | null>(null)
  const [bundle, setBundle] = useState<TripBundle | null>(null)
  const [catalog, setCatalog] = useState<AirportCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [fitRequest, setFitRequest] = useState(0)
  const currentRef = useRef<string | null>(null)
  useEffect(() => {
    currentRef.current = currentTripId
  }, [currentTripId])

  // 初始化本地存储
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setStorageError(null)
    ;(async () => {
      try {
        await repo.open()
        const list = await repo.listTrips()
        if (cancelled) return
        setTrips(list)
        const last = readLastTrip()
        const initial = list.find((t) => t.id === last)?.id ?? list.at(-1)?.id ?? null
        currentRef.current = initial
        setCurrentTripId(initial)
        setFitRequest((n) => n + 1)
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setStorageError(describeError(err))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repo, storageAttempt])

  // 加载机场目录
  useEffect(() => {
    let cancelled = false
    setCatalogError(null)
    loadAirportCatalog()
      .then((c) => !cancelled && setCatalog(c))
      .catch((err) => !cancelled && setCatalogError(describeError(err)))
    return () => {
      cancelled = true
    }
  }, [catalogAttempt])

  const reloadBundle = useCallback(
    async (tripId: string | null) => {
      if (!tripId) {
        setBundle(null)
        return
      }
      const b = await repo.getBundle(tripId)
      if (currentRef.current === tripId) setBundle(b)
    },
    [repo],
  )

  useEffect(() => {
    writeLastTrip(currentTripId)
    if (status !== 'ready') return
    reloadBundle(currentTripId).catch((err) => setStorageError(describeError(err)))
  }, [currentTripId, status, reloadBundle])

  const refreshTrips = useCallback(async () => setTrips(await repo.listTrips()), [repo])

  const selectTrip = useCallback((id: string | null) => {
    currentRef.current = id
    setCurrentTripId(id)
    setBundle((b) => (b && b.trip.id === id ? b : null))
    setFitRequest((n) => n + 1)
  }, [])

  const requireTrip = () => {
    const id = currentRef.current
    if (!id) throw new Error('请先选择或创建假期')
    return id
  }

  const actions = {
    createTrip: async (input: TripInput) => {
      const trip = await repo.createTrip(input)
      await refreshTrips()
      selectTrip(trip.id)
      return trip
    },
    updateTrip: async (id: string, input: TripInput) => {
      await repo.updateTrip(id, input)
      await refreshTrips()
      await reloadBundle(currentRef.current)
    },
    deleteTrip: async (id: string) => {
      await repo.deleteTrip(id)
      const list = await repo.listTrips()
      setTrips(list)
      if (currentRef.current === id) selectTrip(list.at(-1)?.id ?? null)
    },
    addLeg: async (input: LegInput) => {
      const id = requireTrip()
      await repo.addLeg(id, input)
      await reloadBundle(id)
    },
    updateLeg: async (legId: string, input: LegInput) => {
      await repo.updateLeg(legId, input)
      await reloadBundle(currentRef.current)
    },
    deleteLeg: async (legId: string) => {
      await repo.deleteLeg(legId)
      await reloadBundle(currentRef.current)
    },
    moveLeg: async (legId: string, dir: -1 | 1) => {
      await repo.moveLeg(legId, dir)
      await reloadBundle(currentRef.current)
    },
    loadSample: async () => {
      const cat = catalog ?? (await loadAirportCatalog())
      const legs = SAMPLE_TRIP.legs.map(([from, to, date]) => {
        const a = cat.byIata.get(from)
        const b = cat.byIata.get(to)
        if (!a || !b) throw new Error(`示例机场缺失：${from}/${to}`)
        return { from: a, to: b, date }
      })
      const trip = await repo.createSampleTrip(SAMPLE_TRIP.title, legs, SAMPLE_TRIP.range)
      await refreshTrips()
      selectTrip(trip.id)
    },
    exportBackup: () => repo.exportBackup(),
    planImport: (backup: BackupV1) => repo.planImport(backup),
    findDuplicateTrips: (backup: BackupV1) => repo.findDuplicateTrips(backup),
    applyImport: async (plan: ImportPlan) => {
      await repo.applyImport(plan)
      await refreshTrips()
      if (plan.trips[0]) selectTrip(plan.trips[0].id)
    },
    subscribeLocalChanges: (fn: () => void) => repo.onChange(fn),
    refreshFromStorage: async (renamed?: Map<string, string>) => {
      const list = await repo.listTrips()
      setTrips(list)
      let current = currentRef.current
      if (current && renamed?.has(current)) current = renamed.get(current)!
      if (current && !list.some((t) => t.id === current)) current = list.at(-1)?.id ?? null
      if (current === null && list.length > 0) current = list.at(-1)!.id
      if (current !== currentRef.current) {
        selectTrip(current)
      } else {
        await reloadBundle(current)
      }
    },
  }

  const airportsById = useMemo(() => new Map<string, Airport>((bundle?.airports ?? []).map((a) => [a.id, a])), [bundle])

  const value: AppData = {
    status,
    storageError,
    retryStorage: () => setStorageAttempt((n) => n + 1),
    trips,
    currentTripId,
    bundle: bundle && bundle.trip.id === currentTripId ? bundle : null,
    airportsById,
    selectTrip,
    catalog,
    catalogError,
    retryCatalog: () => setCatalogAttempt((n) => n + 1),
    fitRequest,
    requestFit: () => setFitRequest((n) => n + 1),
    ...actions,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppData(): AppData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAppData must be used within AppDataProvider')
  return v
}
