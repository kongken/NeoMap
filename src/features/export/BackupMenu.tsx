import { useState } from 'react'
import { DatabaseBackup, Download, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAppData } from '@/app/AppDataContext'
import { ImportDialog } from './ImportDialog'
import { downloadBlob } from './poster'

export function BackupMenu({ compact = false }: { compact?: boolean }) {
  const { exportBackup, status } = useAppData()
  const [importOpen, setImportOpen] = useState(false)

  const doExport = async () => {
    try {
      const backup = await exportBackup()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      downloadBlob(blob, `holiday-flight-map-backup-${backup.exportedAt.slice(0, 10)}.json`)
      toast.success(`已导出 ${backup.trips.length} 个假期`)
    } catch (err) {
      toast.error(`导出备份失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size={compact ? 'icon' : 'default'} disabled={status !== 'ready'} aria-label="备份与恢复">
            <DatabaseBackup aria-hidden />
            {!compact && '备份'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">数据仅保存在当前浏览器</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={doExport}>
            <Download aria-hidden />
            导出备份（JSON）
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <Upload aria-hidden />
            导入备份…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  )
}
