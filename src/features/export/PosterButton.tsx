import { useState } from 'react'
import { ImageDown, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TripGeometry, TripStats } from '@/lib/geo/tripGeometry'
import { isWebglAvailable } from '@/features/map/mapConfig'
import { useAppData } from '@/app/AppDataContext'
import { downloadBlob, ExportError, exportFileName } from './exportMap'
import { renderPoster } from './poster'

interface Props {
  geometry: TripGeometry
  stats: TripStats
  compact?: boolean
}

export function PosterButton({ geometry, stats, compact = false }: Props) {
  const { bundle } = useAppData()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ExportError | null>(null)

  const run = async (withoutBasemap: boolean) => {
    if (!bundle || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const blob = await renderPoster({ trip: bundle.trip, geometry, stats, withoutBasemap })
      downloadBlob(blob, exportFileName(bundle.trip, 'png', withoutBasemap ? '-no-basemap' : ''))
      toast.success(withoutBasemap ? '已导出无底图海报' : '海报已导出')
    } catch (err) {
      setFailure(err instanceof ExportError ? err : new ExportError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const disabledReason = !bundle ? '请先选择假期' : geometry.legs.length === 0 ? '添加航段后可导出海报' : !isWebglAvailable() ? '浏览器不支持地图渲染' : null

  return (
    <>
      <Button onClick={() => run(false)} disabled={busy || !!disabledReason} title={disabledReason ?? '导出 1600×1000 PNG 海报'} aria-label={compact ? '导出海报' : undefined} size={compact ? 'icon' : 'default'}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ImageDown aria-hidden />}
        {!compact && (busy ? '正在生成…' : '导出海报')}
      </Button>
      {busy && (
        <span className="sr-only" role="status">
          正在生成海报
        </span>
      )}
      <Dialog open={!!failure} onOpenChange={(o) => !o && !busy && setFailure(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-5 text-amber-500" aria-hidden />
              海报导出失败
            </DialogTitle>
            <DialogDescription>未保存任何文件。</DialogDescription>
          </DialogHeader>
          <p className="break-words text-sm" role="alert">
            {failure?.message}
          </p>
          {failure?.basemapFailure && <p className="text-sm text-muted-foreground">如果底图服务暂时不可用，可以改为导出明确标注「无底图」的航线海报。</p>}
          <DialogFooter>
            {failure?.basemapFailure && (
              <Button variant="outline" onClick={() => run(true)} disabled={busy}>
                导出无底图海报
              </Button>
            )}
            <Button onClick={() => run(false)} disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              重试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
