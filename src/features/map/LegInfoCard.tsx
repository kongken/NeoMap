import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { displayCity, displayName } from '@/lib/airports/catalog'
import { formatKm, type LegGeometry } from '@/lib/geo/tripGeometry'

interface Props {
  leg: LegGeometry
  onClose: () => void
}

/** 选中航段的信息面板 */
export function LegInfoCard({ leg, onClose }: Props) {
  const { from, to, leg: l } = leg
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur" role="dialog" aria-label={`第 ${leg.number} 段详情`} data-testid="leg-info">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: leg.color }} aria-hidden>
          {leg.number}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-lg font-semibold leading-tight">
            {from.iata} → {to.iata}
          </p>
          <p className="text-xs text-muted-foreground">第 {leg.number} 段</p>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="关闭航段详情" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1 text-sm">
        <dt className="text-muted-foreground">出发</dt>
        <dd className="min-w-0 truncate" title={from.name}>
          {displayCity(from)} · {displayName(from)}
        </dd>
        <dt className="text-muted-foreground">到达</dt>
        <dd className="min-w-0 truncate" title={to.name}>
          {displayCity(to)} · {displayName(to)}
        </dd>
        <dt className="text-muted-foreground">日期</dt>
        <dd>{l.departureDate}</dd>
        {l.flightNumber && (
          <>
            <dt className="text-muted-foreground">航班号</dt>
            <dd>{l.flightNumber}</dd>
          </>
        )}
        {l.airline && (
          <>
            <dt className="text-muted-foreground">航空公司</dt>
            <dd className="truncate">{l.airline}</dd>
          </>
        )}
        <dt className="text-muted-foreground">估算距离</dt>
        <dd>{formatKm(Math.round(leg.route.totalKm))}</dd>
      </dl>
      {l.notes && <p className="mt-2 whitespace-pre-wrap break-words border-t pt-2 text-sm text-muted-foreground">{l.notes}</p>}
    </div>
  )
}
