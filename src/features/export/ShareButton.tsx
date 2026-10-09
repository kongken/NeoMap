import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Copy, Download, Loader2, Share2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { TripGeometry, TripStats } from '@/lib/geo/tripGeometry'
import { isWebglAvailable } from '@/features/map/mapConfig'
import { useAppData } from '@/app/AppDataContext'
import { downloadBlob, ExportError, exportFileName } from './exportMap'
import { renderPoster } from './poster'
import { buildShareText, loadMastodonInstance, normalizeMastodonInstance, saveMastodonInstance, shareIntentUrl, X_MAX_WEIGHT, xWeightedLength, type SharePlatform } from './share'

interface Props {
  geometry: TripGeometry
  stats: TripStats
  compact?: boolean
}

type Poster = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ready'; blob: Blob; url: string; withoutBasemap: boolean } | { kind: 'error'; error: ExportError }

const PLATFORMS: [SharePlatform, string][] = [
  ['x', 'X'],
  ['bluesky', 'Bluesky'],
  ['mastodon', 'Mastodon'],
]

const canCopyImage = () => typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

export function ShareButton({ geometry, stats, compact = false }: Props) {
  const { bundle } = useAppData()
  const [open, setOpen] = useState(false)
  const [poster, setPoster] = useState<Poster>({ kind: 'idle' })
  const [text, setText] = useState('')
  const [instance, setInstance] = useState<string | null>(() => loadMastodonInstance())
  const [editingInstance, setEditingInstance] = useState(false)
  const [instanceDraft, setInstanceDraft] = useState('')
  const [instanceError, setInstanceError] = useState<string | null>(null)
  // 关闭对话框或重新生成后，旧的生成结果作废
  const runRef = useRef(0)
  const textId = useId()
  const instanceId = useId()

  const disabledReason = !bundle ? '请先选择假期' : geometry.legs.length === 0 ? '添加航段后可分享' : !isWebglAvailable() ? '浏览器不支持地图渲染' : null

  const generate = async (withoutBasemap: boolean) => {
    if (!bundle) return
    const run = ++runRef.current
    setPoster({ kind: 'busy' })
    try {
      const blob = await renderPoster({ trip: bundle.trip, geometry, stats, withoutBasemap })
      if (run !== runRef.current) return
      setPoster({ kind: 'ready', blob, url: URL.createObjectURL(blob), withoutBasemap })
    } catch (err) {
      if (run !== runRef.current) return
      setPoster({ kind: 'error', error: err instanceof ExportError ? err : new ExportError(err instanceof Error ? err.message : String(err)) })
    }
  }

  const readyUrl = poster.kind === 'ready' ? poster.url : null
  useEffect(() => () => void (readyUrl && URL.revokeObjectURL(readyUrl)), [readyUrl])

  const onOpenChange = (o: boolean) => {
    setOpen(o)
    if (o) {
      if (bundle) setText(buildShareText(bundle.trip, stats))
      setEditingInstance(false)
      void generate(false)
    } else {
      runRef.current++
      setPoster({ kind: 'idle' })
    }
  }

  const fileName = bundle && poster.kind === 'ready' ? exportFileName(bundle.trip, 'png', poster.withoutBasemap ? '-no-basemap' : '') : 'holiday-flight-map.png'
  const posterFile = poster.kind === 'ready' ? new File([poster.blob], fileName, { type: 'image/png' }) : null
  const canSystemShare = !!posterFile && !!navigator.canShare?.({ files: [posterFile], text })

  const copyImage = async () => {
    if (poster.kind !== 'ready') return
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': poster.blob })])
      toast.success('海报已复制，可在发帖页直接粘贴')
    } catch {
      toast.error('无法复制图片，请改用下载')
    }
  }

  const systemShare = async () => {
    if (!posterFile) return
    try {
      await navigator.share({ files: [posterFile], text })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast.error('系统分享失败')
    }
  }

  const saveInstance = (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeMastodonInstance(instanceDraft)
    if (!normalized) {
      setInstanceError('请输入实例域名，例如 mastodon.social')
      return
    }
    saveMastodonInstance(normalized)
    setInstance(normalized)
    setEditingInstance(false)
  }

  const startEditInstance = () => {
    setInstanceDraft(instance ?? '')
    setInstanceError(null)
    setEditingInstance(true)
  }

  const xWeight = xWeightedLength(text)

  return (
    <>
      <Button
        onClick={() => onOpenChange(true)}
        disabled={!!disabledReason}
        title={disabledReason ?? '分享到 X / Bluesky / Mastodon'}
        aria-label={compact ? '分享' : undefined}
        size={compact ? 'icon' : 'default'}
        variant="outline"
      >
        <Share2 aria-hidden />
        {!compact && '分享'}
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>分享航线图</DialogTitle>
            <DialogDescription>打开发帖页后，把海报粘贴或上传进去即可。</DialogDescription>
          </DialogHeader>

          <div className="flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg border bg-muted">
            {poster.kind === 'ready' && <img src={poster.url} alt="海报预览" className="size-full object-contain" />}
            {poster.kind === 'busy' && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                正在生成海报…
              </span>
            )}
            {poster.kind === 'error' && (
              <div className="flex flex-col items-center gap-2 p-4 text-center text-sm" role="alert">
                <span className="flex items-center gap-1.5 font-medium">
                  <TriangleAlert className="size-4 text-amber-500" aria-hidden />
                  海报生成失败
                </span>
                <span className="break-words text-muted-foreground">{poster.error.message}</span>
                <div className="flex gap-2">
                  {poster.error.basemapFailure && (
                    <Button size="sm" variant="outline" onClick={() => generate(true)}>
                      使用无底图海报
                    </Button>
                  )}
                  <Button size="sm" onClick={() => generate(false)}>
                    重试
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {canCopyImage() && (
              <Button size="sm" variant="outline" onClick={copyImage} disabled={poster.kind !== 'ready'}>
                <Copy aria-hidden />
                复制图片
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => poster.kind === 'ready' && downloadBlob(poster.blob, fileName)} disabled={poster.kind !== 'ready'}>
              <Download aria-hidden />
              下载图片
            </Button>
            {canSystemShare && (
              <Button size="sm" onClick={systemShare}>
                <Share2 aria-hidden />
                系统分享…
              </Button>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={textId} className="text-sm font-medium">
              分享文案
            </label>
            <Textarea id={textId} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
            <p className={cn('text-xs', xWeight > X_MAX_WEIGHT ? 'text-destructive' : 'text-muted-foreground')}>
              X 约 {xWeight}/{X_MAX_WEIGHT}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map(([platform, label]) => {
              const href = shareIntentUrl(platform, text, instance)
              return href ? (
                <a key={platform} href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'default' })}>
                  发到 {label}
                </a>
              ) : (
                <Button key={platform} onClick={startEditInstance}>
                  发到 {label}
                </Button>
              )
            })}
          </div>

          {editingInstance ? (
            <form onSubmit={saveInstance} className="space-y-1.5">
              <label htmlFor={instanceId} className="text-sm font-medium">
                Mastodon 实例
              </label>
              <div className="flex gap-2">
                <Input
                  id={instanceId}
                  value={instanceDraft}
                  onChange={(e) => {
                    setInstanceDraft(e.target.value)
                    setInstanceError(null)
                  }}
                  placeholder="mastodon.social"
                  autoFocus
                  aria-invalid={!!instanceError}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button type="submit">保存</Button>
              </div>
              {instanceError && (
                <p className="text-xs text-destructive" role="alert">
                  {instanceError}
                </p>
              )}
            </form>
          ) : (
            instance && (
              <p className="text-xs text-muted-foreground">
                Mastodon 实例：{instance} ·{' '}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={startEditInstance}>
                  更改
                </button>
              </p>
            )
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
