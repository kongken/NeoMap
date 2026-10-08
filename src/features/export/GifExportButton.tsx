import { useRef, useState } from 'react'
import { Clapperboard, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { TripGeometry } from '@/lib/geo/tripGeometry'
import { isWebglAvailable } from '@/features/map/mapConfig'
import { useAppData } from '@/app/AppDataContext'
import { downloadBlob, ExportAbortedError, ExportError, exportFileName } from './exportMap'
import { GIF_SIZES, legSeconds, planGifFrames, type GifSize } from './gifPlan'
import { renderRouteGif, type GifProgress, type GifResult } from './gifExport'

interface Props {
  geometry: TripGeometry
  compact?: boolean
}

type Stage =
  | { kind: 'options' }
  | { kind: 'running'; progress: GifProgress }
  | { kind: 'done'; result: GifResult; fileName: string }
  | { kind: 'error'; error: ExportError }

const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export function GifExportButton({ geometry, compact = false }: Props) {
  const { bundle } = useAppData()
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState<GifSize>('small')
  const [stage, setStage] = useState<Stage>({ kind: 'options' })
  const abortRef = useRef<AbortController | null>(null)

  const legCount = geometry.legs.length
  const frames = planGifFrames(legCount)
  const durationSec = frames.reduce((s, f) => s + f.delayMs, 0) / 1000
  const running = stage.kind === 'running'

  const disabledReason = !bundle ? '请先选择假期' : legCount === 0 ? '添加航段后可导出动画' : !isWebglAvailable() ? '浏览器不支持地图渲染' : null

  const run = async (withoutBasemap: boolean) => {
    if (!bundle) return
    const controller = new AbortController()
    abortRef.current = controller
    setStage({ kind: 'running', progress: { stage: 'map', ratio: 0 } })
    try {
      const result = await renderRouteGif({
        trip: bundle.trip,
        geometry,
        size,
        withoutBasemap,
        signal: controller.signal,
        onProgress: (progress) => setStage({ kind: 'running', progress }),
      })
      const fileName = exportFileName(bundle.trip, 'gif', withoutBasemap ? '-no-basemap' : '')
      downloadBlob(result.blob, fileName)
      setStage({ kind: 'done', result, fileName })
      toast.success('动画 GIF 已导出')
    } catch (err) {
      if (err instanceof ExportAbortedError) {
        setStage({ kind: 'options' })
        return
      }
      setStage({ kind: 'error', error: err instanceof ExportError ? err : new ExportError(err instanceof Error ? err.message : String(err)) })
    } finally {
      abortRef.current = null
    }
  }

  const close = (o: boolean) => {
    if (!o) {
      // 关闭即取消正在进行的导出
      abortRef.current?.abort()
      setStage({ kind: 'options' })
    }
    setOpen(o)
  }

  const progressText = (p: GifProgress) =>
    p.stage === 'map' ? '正在加载地图和底图瓦片…' : p.stage === 'frames' ? `正在生成第 ${p.frame}/${p.totalFrames} 帧…` : '即将完成…'
  const progressRatio = (p: GifProgress) => (p.stage === 'map' ? 0.05 : 0.05 + p.ratio * 0.95)

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={!!disabledReason}
        title={disabledReason ?? '导出航线动画 GIF'}
        aria-label={compact ? '导出动画 GIF' : undefined}
        size={compact ? 'icon' : 'default'}
      >
        <Clapperboard aria-hidden />
        {!compact && '导出动画'}
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>导出航线动画 GIF</DialogTitle>
            <DialogDescription>飞机按航段顺序依次飞过整段行程，动画循环播放。生成过程在浏览器内完成，不会改变当前地图视角和回放进度。</DialogDescription>
          </DialogHeader>

          {stage.kind === 'options' && (
            <div className="space-y-4 text-sm">
              <fieldset className="space-y-2">
                <legend className="mb-1 font-medium">尺寸</legend>
                {(Object.keys(GIF_SIZES) as GifSize[]).map((key) => (
                  <label key={key} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border p-2.5', size === key && 'border-primary bg-primary/5')}>
                    <input type="radio" name="gif-size" value={key} checked={size === key} onChange={() => setSize(key)} className="accent-primary" />
                    {GIF_SIZES[key].label}
                  </label>
                ))}
              </fieldset>
              <p className="text-muted-foreground">
                {legCount} 段航程，每段约 {legSeconds(legCount).toFixed(1)} 秒，共 {frames.length} 帧，播放一轮约 {durationSec.toFixed(1)} 秒。动画时长仅为演示，与实际飞行时长无关。
              </p>
            </div>
          )}

          {stage.kind === 'running' && (
            <div className="space-y-2 text-sm" role="status" aria-live="polite">
              <p className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {progressText(stage.progress)}
              </p>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="GIF 生成进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progressRatio(stage.progress) * 100)}
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${progressRatio(stage.progress) * 100}%` }} />
              </div>
            </div>
          )}

          {stage.kind === 'done' && (
            <div className="space-y-1 text-sm" role="status">
              <p className="font-medium">已生成并开始下载</p>
              <p className="break-all text-muted-foreground">{stage.fileName}</p>
              <p className="text-muted-foreground">
                {stage.result.width}×{stage.result.height} · {stage.result.frames} 帧 · {(stage.result.durationMs / 1000).toFixed(1)} 秒 · {formatBytes(stage.result.blob.size)}
              </p>
            </div>
          )}

          {stage.kind === 'error' && (
            <div className="space-y-2 text-sm">
              <p className="flex gap-2 rounded-md bg-destructive/10 p-2 text-destructive" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="break-words">{stage.error.message}。未保存任何文件。</span>
              </p>
              {stage.error.basemapFailure && <p className="text-muted-foreground">如果底图服务暂时不可用，可以改为导出明确标注「无底图」的动画。</p>}
            </div>
          )}

          <DialogFooter>
            {stage.kind === 'running' ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                取消
              </Button>
            ) : stage.kind === 'done' ? (
              <>
                <Button variant="outline" onClick={() => setStage({ kind: 'options' })}>
                  重新导出
                </Button>
                <Button onClick={() => close(false)}>完成</Button>
              </>
            ) : stage.kind === 'error' ? (
              <>
                {stage.error.basemapFailure && (
                  <Button variant="outline" onClick={() => run(true)}>
                    导出无底图动画
                  </Button>
                )}
                <Button onClick={() => run(false)}>重试</Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => close(false)}>
                  取消
                </Button>
                <Button onClick={() => run(false)} disabled={running}>
                  生成 GIF
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
