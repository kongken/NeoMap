import { cn } from '@/lib/utils'
import type { TripStats } from '@/lib/geo/tripGeometry'

interface Props {
  stats: TripStats
  className?: string
}

export function StatsBar({ stats, className }: Props) {
  const items: [string, string, string?][] = [
    ['航段', String(stats.legCount)],
    ['机场', String(stats.airportCount), '去重后的机场数'],
    ['到达城市', String(stats.cityCount), '按城市名 + 国家或地区去重；无城市信息时按机场计'],
    ['估算距离', `${stats.totalKm.toLocaleString('zh-CN')} km`, '按大圆距离估算'],
  ]
  return (
    <dl className={cn('grid grid-cols-4 gap-2', className)} data-testid="stats">
      {items.map(([label, value, title]) => (
        <div key={label} className="min-w-0" title={title}>
          <dt className="truncate text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-base font-semibold tabular-nums sm:text-lg">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
