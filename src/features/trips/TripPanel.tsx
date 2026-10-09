import { useState } from 'react'
import { CalendarDays, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useAppData } from '@/app/AppDataContext'
import { formatDateRange } from '@/features/export/exportMap'
import { TripFormDialog } from './TripFormDialog'
import { useSync } from '@/features/sync/SyncContext'
import { useAuth } from '@/features/auth/AuthContext'
import type { TripSyncRecord } from '@/lib/sync/types'

/** 当前假期信息：标题、日期、备注、编辑与删除 */
export function TripPanel() {
  const { bundle, deleteTrip } = useAppData()
  const sync = useSync()
  const auth = useAuth()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!bundle) return null
  const { trip, legs } = bundle
  const range = formatDateRange(trip)

  return (
    <section aria-labelledby="current-trip-title" className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1 id="current-trip-title" className="break-words text-xl font-semibold leading-tight" data-testid="trip-title">
            {trip.title}
          </h1>
          {trip.isSample && (
            <Badge variant="secondary" className="mt-1">
              示例行程，非真实记录
            </Badge>
          )}
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="编辑假期" onClick={() => setEditOpen(true)}>
          <Pencil aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="删除假期" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      <TripSyncBadge
        record={sync.records.get(trip.id)}
        canUpload={auth.state.status === 'authenticated' && sync.account !== null}
        onUpload={() => sync.uploadLocalOnly(trip.id)}
      />
      {range && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CalendarDays className="size-4" aria-hidden />
          {range}
        </p>
      )}
      {trip.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{trip.notes}</p>}

      <TripFormDialog open={editOpen} onOpenChange={setEditOpen} trip={trip} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除这个假期？"
        description={
          <>
            将删除「{trip.title}」及其 <strong>{legs.length}</strong> 个航段。此操作无法撤销，如需保留请先导出备份。
          </>
        }
        confirmLabel="删除假期"
        destructive
        onConfirm={async () => {
          await deleteTrip(trip.id)
          toast.success('假期已删除')
        }}
      />
    </section>
  )
}


/** 当前假期的同步提示：「仅本设备」可单独上传；同步失败显示原因 */
function TripSyncBadge({ record, canUpload, onUpload }: { record?: TripSyncRecord; canUpload: boolean; onUpload: () => Promise<void> }) {
  if (!record || !canUpload) return null
  if (record.localOnly) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">仅本设备</Badge>
        <Button size="sm" variant="link" className="h-auto p-0" onClick={() => void onUpload().then(() => toast.success('已加入同步'))}>
          上传到账号
        </Button>
      </div>
    )
  }
  if (record.state === 'error') {
    return (
      <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive" role="status">
        无法同步：{record.error ?? '未知原因'}。修改后会自动重试。
      </p>
    )
  }
  return null
}
