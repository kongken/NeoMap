import { useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, Info, Pencil, Plane, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import { displayCity } from '@/lib/airports/catalog'
import { discontinuousLegIds, legColor, type TripGeometry } from '@/lib/geo/tripGeometry'
import type { FlightLeg } from '@/types'
import { useAppData } from '@/app/AppDataContext'
import { LegFormDialog } from './LegFormDialog'

interface Props {
  geometry: TripGeometry
  selectedLegId: string | null
  activeLegId: string | null
  onSelectLeg: (id: string | null) => void
}

export function LegList({ geometry, selectedLegId, activeLegId, onSelectLeg }: Props) {
  const { bundle, airportsById, moveLeg, deleteLeg } = useAppData()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<FlightLeg | null>(null)
  const [deleting, setDeleting] = useState<FlightLeg | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  if (!bundle) return null
  const legs = bundle.legs
  const gaps = discontinuousLegIds(legs, airportsById)
  const invalid = new Set(geometry.invalidLegIds)
  const warned = new Map(geometry.warnings.map((w) => [w.legId, w.warning]))

  const move = async (leg: FlightLeg, dir: -1 | 1) => {
    setBusyId(leg.id)
    try {
      await moveLeg(leg.id, dir)
    } catch (err) {
      toast.error(`调整顺序失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section aria-labelledby="legs-heading" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="legs-heading" className="text-sm font-semibold">
          航段 <span className="font-normal text-muted-foreground">（按播放顺序）</span>
        </h2>
        <Button
          size="sm"
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus aria-hidden />
          添加航段
        </Button>
      </div>

      {legs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
          <Plane className="mx-auto mb-2 size-6 text-primary" aria-hidden />
          还没有航段。点击「添加航段」录入第一段航班。
        </div>
      ) : (
        <ol className="space-y-2">
          {legs.map((leg, i) => {
            const from = airportsById.get(leg.departureAirportId)
            const to = airportsById.get(leg.arrivalAirportId)
            const color = legColor(i)
            const selected = leg.id === selectedLegId
            const active = leg.id === activeLegId
            return (
              <li key={leg.id}>
                {gaps.has(leg.id) && (
                  <p className="mb-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                    <Info className="size-3.5" aria-hidden />
                    与上一段不连续（中间可能乘坐其他交通）
                  </p>
                )}
                <div
                  className={cn(
                    'group relative rounded-lg border bg-card transition-colors',
                    selected ? 'border-primary ring-2 ring-primary/30' : 'hover:border-foreground/20',
                    active && !selected && 'border-foreground/30',
                  )}
                  data-testid="leg-item"
                >
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 rounded-lg p-3 pr-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    aria-pressed={selected}
                    aria-label={`第 ${i + 1} 段：${from?.iata ?? '?'} 到 ${to?.iata ?? '?'}，${leg.departureDate}${selected ? '，已选中' : ''}`}
                    onClick={() => onSelectLeg(selected ? null : leg.id)}
                  >
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: color }} aria-hidden>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-mono text-base font-semibold">
                        {from?.iata ?? '???'}
                        <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
                        {to?.iata ?? '???'}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {from ? displayCity(from) : '未知机场'} → {to ? displayCity(to) : '未知机场'}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {leg.departureDate}
                        {leg.flightNumber ? ` · ${leg.flightNumber}` : ''}
                        {leg.airline ? ` · ${leg.airline}` : ''}
                      </span>
                      {invalid.has(leg.id) && (
                        <span className="mt-1 flex items-center gap-1 text-xs text-destructive">
                          <TriangleAlert className="size-3.5" aria-hidden />
                          无法绘制此航段
                        </span>
                      )}
                      {warned.get(leg.id) === 'antipodal' && (
                        <span className="mt-1 flex items-center gap-1 text-xs text-amber-700">
                          <TriangleAlert className="size-3.5" aria-hidden />
                          两地近乎位于地球两端，航线方向仅为示意
                        </span>
                      )}
                    </span>
                    <span className="mt-1 size-3 shrink-0 rounded-sm" style={{ backgroundColor: color }} aria-hidden />
                  </button>
                  <div className="flex items-center justify-end gap-0.5 border-t px-2 py-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`上移第 ${i + 1} 段`} disabled={i === 0 || busyId !== null} onClick={() => move(leg, -1)}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`下移第 ${i + 1} 段`} disabled={i === legs.length - 1 || busyId !== null} onClick={() => move(leg, 1)}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(leg)
                        setFormOpen(true)
                      }}
                    >
                      <Pencil aria-hidden />
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(leg)}>
                      <Trash2 aria-hidden />
                      删除
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <LegFormDialog open={formOpen} onOpenChange={setFormOpen} leg={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="删除航段？"
        description={
          deleting
            ? `将删除 ${airportsById.get(deleting.departureAirportId)?.iata ?? '?'} → ${airportsById.get(deleting.arrivalAirportId)?.iata ?? '?'}（${deleting.departureDate}）。此操作无法撤销。`
            : ''
        }
        confirmLabel="删除"
        destructive
        onConfirm={async () => {
          if (!deleting) return
          if (selectedLegId === deleting.id) onSelectLeg(null)
          await deleteLeg(deleting.id)
          toast.success('航段已删除')
        }}
      />
    </section>
  )
}
