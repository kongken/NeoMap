import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAppData } from '@/app/AppDataContext'

export function TripSelector({ onCreate }: { onCreate: () => void }) {
  const { trips, currentTripId, selectTrip, status } = useAppData()
  return (
    <div className="flex min-w-0 items-center gap-2">
      {trips.length > 0 && (
        <Select value={currentTripId ?? undefined} onValueChange={(v) => selectTrip(v)}>
          <SelectTrigger className="h-9 w-full min-w-0 sm:w-64" aria-label="选择假期" data-testid="trip-select">
            <SelectValue placeholder="选择假期" />
          </SelectTrigger>
          <SelectContent>
            {trips.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="truncate">{t.title}</span>
                {t.isSample && <span className="ml-1 text-xs text-muted-foreground">（示例）</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="outline" onClick={onCreate} disabled={status !== 'ready'} className="shrink-0">
        <Plus aria-hidden />
        新建假期
      </Button>
    </div>
  )
}
