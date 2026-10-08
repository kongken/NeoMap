import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, List, Loader2, Map as MapIcon, Maximize, Plane, RefreshCw } from 'lucide-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { buildTripGeometry, computeStats } from '@/lib/geo/tripGeometry'
import { AppDataProvider, useAppData } from './AppDataContext'
import { MapView, type FitPadding } from '@/features/map/MapView'
import { LegInfoCard } from '@/features/map/LegInfoCard'
import { LegList } from '@/features/flights/LegList'
import { TripPanel } from '@/features/trips/TripPanel'
import { TripSelector } from '@/features/trips/TripSelector'
import { TripFormDialog } from '@/features/trips/TripFormDialog'
import { EmptyState } from '@/features/trips/EmptyState'
import { StatsBar } from '@/features/stats/StatsBar'
import { PlaybackControls } from '@/features/playback/PlaybackControls'
import { usePlayback } from '@/features/playback/usePlayback'
import { BackupMenu } from '@/features/export/BackupMenu'
import { PosterButton } from '@/features/export/PosterButton'

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const on = () => setMatches(mql.matches)
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [query])
  return matches
}

function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, height] as const
}

function Workspace() {
  const data = useAppData()
  const { status, storageError, retryStorage, trips, bundle, airportsById, fitRequest, requestFit } = data
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const [mobileView, setMobileView] = useState<'map' | 'list'>('map')
  const [createOpen, setCreateOpen] = useState(false)
  // 选中状态与假期绑定；航段被删除或切换假期后自动失效
  const [selection, setSelection] = useState<{ tripId: string; legId: string } | null>(null)
  const [overlayRef, overlayHeight] = useElementHeight<HTMLDivElement>()

  const legs = useMemo(() => bundle?.legs ?? [], [bundle])
  const geometry = useMemo(() => buildTripGeometry(legs, airportsById), [legs, airportsById])
  const stats = useMemo(() => computeStats(legs, airportsById), [legs, airportsById])
  const resetKey = `${bundle?.trip.id ?? ''}|${legs.map((l) => `${l.id}:${l.order}:${l.updatedAt}`).join(',')}`
  const playback = usePlayback(geometry, resetKey)

  const selectedLegId = selection && selection.tripId === bundle?.trip.id && legs.some((l) => l.id === selection.legId) ? selection.legId : null
  const tripId = bundle?.trip.id ?? null
  const setSelectedLegId = useCallback((id: string | null) => setSelection(id && tripId ? { tripId, legId: id } : null), [tripId])

  const selected = geometry.legs.find((g) => g.leg.id === selectedLegId) ?? null
  const active = geometry.legs.find((g) => g.leg.id === playback.activeLegId)
  const playbackLabel = active ? `第 ${active.number}/${geometry.legs.length} 段 · ${active.from.iata} → ${active.to.iata}` : null

  const padding: FitPadding = useMemo(
    () => ({ top: isDesktop ? 90 : 80, right: isDesktop ? 80 : 56, left: isDesktop ? 60 : 36, bottom: overlayHeight + 50 }),
    [isDesktop, overlayHeight],
  )

  const onSelectLeg = useCallback(
    (id: string | null) => {
      setSelectedLegId(id)
      if (id && !isDesktop) setMobileView('map')
    },
    [isDesktop, setSelectedLegId],
  )

  const noTrips = status === 'ready' && trips.length === 0

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {/* 顶栏 */}
      <header className="z-20 flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 lg:flex-nowrap lg:px-4">
        <div className="flex items-center gap-2 font-semibold">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Plane className="size-4" aria-hidden />
          </span>
          <span className="hidden sm:inline">假日飞行航线图</span>
        </div>
        <div className="order-last w-full min-w-0 lg:order-none lg:ml-4 lg:w-auto">
          <TripSelector onCreate={() => setCreateOpen(true)} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <BackupMenu compact={!isDesktop} />
          <PosterButton geometry={geometry} stats={stats} compact={!isDesktop} />
        </div>
      </header>

      {/* 手机：地图 / 航段切换 */}
      {!isDesktop && (
        <div className="flex shrink-0 gap-1 border-b bg-background p-1.5" role="tablist" aria-label="视图">
          {(
            [
              ['map', '地图', MapIcon],
              ['list', `航段${legs.length ? `（${legs.length}）` : ''}`, List],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mobileView === key}
              className={cn('flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium', mobileView === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
              onClick={() => setMobileView(key)}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 侧栏 */}
        <aside className={cn('flex min-h-0 w-full flex-col border-r bg-background lg:w-[360px] lg:shrink-0', !isDesktop && mobileView !== 'list' && 'hidden')} aria-label="假期与航段">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            {status === 'loading' && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                正在读取本地数据…
              </p>
            )}
            {(status === 'error' || storageError) && (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="size-4" aria-hidden />
                  无法访问浏览器本地存储
                </p>
                <p className="text-muted-foreground">可能处于隐私浏览模式、存储空间已满或站点数据被禁用。行程暂时无法读取或保存。</p>
                {storageError && <p className="break-words text-xs text-muted-foreground">详情：{storageError}</p>}
                <Button size="sm" variant="outline" onClick={retryStorage}>
                  <RefreshCw aria-hidden />
                  重试
                </Button>
              </div>
            )}
            {noTrips && <EmptyState onCreate={() => setCreateOpen(true)} />}
            {status === 'ready' && bundle && (
              <>
                <TripPanel />
                <LegList geometry={geometry} selectedLegId={selectedLegId} activeLegId={playback.activeLegId} onSelectLeg={onSelectLeg} />
              </>
            )}
            {status === 'ready' && !bundle && trips.length > 0 && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                正在加载假期…
              </p>
            )}
          </div>
          <p className="shrink-0 border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">数据保存在当前浏览器，请导出备份。清理浏览器站点数据会删除记录。</p>
        </aside>

        {/* 地图 */}
        <main className={cn('relative min-w-0 flex-1', !isDesktop && mobileView !== 'map' && 'hidden')} aria-label="地图">
          <MapView geometry={geometry} selectedLegId={selectedLegId} onSelectLeg={onSelectLeg} plane={playback.plane} fitRequest={fitRequest} padding={padding} />

          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-2">
            <div className="pointer-events-auto">{selected && <LegInfoCard leg={selected} onClose={() => setSelectedLegId(null)} />}</div>
          </div>
          <div className="absolute right-[10px] top-[84px] z-10">
            <Button size="icon" variant="outline" className="size-[29px] rounded-md bg-background shadow-sm" onClick={requestFit} aria-label="重置到完整行程" title="重置到完整行程" disabled={!geometry.bounds}>
              <Maximize className="size-4" aria-hidden />
            </Button>
          </div>

          <div ref={overlayRef} data-testid="map-overlay" className="absolute inset-x-2 bottom-8 z-10 mx-auto max-w-3xl space-y-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur lg:inset-x-4 lg:bottom-9">
            <StatsBar stats={stats} />
            <PlaybackControls playback={playback} label={playbackLabel} />
            <p className="text-center text-[11px] text-muted-foreground">示意航线 · 距离为估算 · 不代表实际飞行路径</p>
          </div>
        </main>
      </div>

      <TripFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

export default function App() {
  return (
    <AppDataProvider>
      <TooltipProvider>
        <Workspace />
        <Toaster position="top-center" offset={{ top: 64 }} mobileOffset={{ top: 110 }} richColors closeButton />
      </TooltipProvider>
    </AppDataProvider>
  )
}
