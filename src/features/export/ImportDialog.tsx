import { useRef, useState } from 'react'
import { FileJson, Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MAX_BACKUP_BYTES, parseBackup } from '@/lib/backup/backup'
import type { BackupV1 } from '@/types'
import { useAppData } from '@/app/AppDataContext'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Stage =
  | { kind: 'pick' }
  | { kind: 'reading' }
  | { kind: 'error'; message: string }
  | { kind: 'confirm'; fileName: string; backup: BackupV1; duplicates: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; trips: number; legs: number }

export function ImportDialog({ open, onOpenChange }: Props) {
  const { findDuplicateTrips, planImport, applyImport } = useAppData()
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = stage.kind === 'reading' || stage.kind === 'importing'

  const close = (o: boolean) => {
    if (busy) return
    onOpenChange(o)
    if (!o) setStage({ kind: 'pick' })
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_BACKUP_BYTES) {
      setStage({ kind: 'error', message: '文件超过 5 MB，无法导入' })
      return
    }
    setStage({ kind: 'reading' })
    try {
      const text = await file.text()
      const result = parseBackup(text, file.size)
      if (!result.ok) {
        setStage({ kind: 'error', message: result.error })
        return
      }
      const duplicates = await findDuplicateTrips(result.backup)
      setStage({ kind: 'confirm', fileName: file.name, backup: result.backup, duplicates })
    } catch (err) {
      setStage({ kind: 'error', message: `读取文件失败：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const doImport = async (backup: BackupV1) => {
    setStage({ kind: 'importing' })
    try {
      const plan = planImport(backup)
      await applyImport(plan)
      setStage({ kind: 'done', trips: plan.trips.length, legs: plan.legs.length })
      toast.success(`已导入 ${plan.trips.length} 个假期`)
    } catch (err) {
      setStage({ kind: 'error', message: `导入失败，现有数据未改动：${err instanceof Error ? err.message : String(err)}` })
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>导入备份</DialogTitle>
          <DialogDescription>备份中的假期会作为新假期追加，不会覆盖现有数据。</DialogDescription>
        </DialogHeader>

        <input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" id="backup-file" data-testid="backup-file" onChange={(e) => onFile(e.target.files?.[0])} />

        {(stage.kind === 'pick' || stage.kind === 'error') && (
          <div className="space-y-3">
            <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
              <FileJson aria-hidden />
              选择备份文件（.json，最大 5 MB）
            </Button>
            {stage.kind === 'error' && (
              <p className="flex gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="break-words">{stage.message}</span>
              </p>
            )}
          </div>
        )}

        {(stage.kind === 'reading' || stage.kind === 'importing') && (
          <p className="flex items-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {stage.kind === 'reading' ? '正在校验文件…' : '正在导入…'}
          </p>
        )}

        {stage.kind === 'confirm' && (
          <div className="space-y-3 text-sm">
            <p className="break-all text-muted-foreground">{stage.fileName}</p>
            <p>
              将追加 <strong>{stage.backup.trips.length}</strong> 个假期、<strong>{stage.backup.legs.length}</strong> 个航段：
            </p>
            <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5">
              {stage.backup.trips.map((t) => (
                <li key={t.id} className="break-words">
                  {t.title}
                </li>
              ))}
            </ul>
            {stage.duplicates.length > 0 && (
              <p className="flex gap-2 rounded-md bg-amber-50 p-2 text-amber-900" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  以下假期似乎已存在：{stage.duplicates.join('、')}。继续导入会产生重复副本。
                </span>
              </p>
            )}
          </div>
        )}

        {stage.kind === 'done' && (
          <p className="text-sm" role="status">
            导入完成：新增 {stage.trips} 个假期、{stage.legs} 个航段。
          </p>
        )}

        <DialogFooter>
          {stage.kind === 'confirm' ? (
            <>
              <Button variant="outline" onClick={() => setStage({ kind: 'pick' })}>
                重新选择
              </Button>
              <Button onClick={() => doImport(stage.backup)}>{stage.duplicates.length ? '仍然追加导入' : '确认导入'}</Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => close(false)} disabled={busy}>
              {stage.kind === 'done' ? '完成' : '取消'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
