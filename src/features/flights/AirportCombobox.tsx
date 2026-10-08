import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { displayCity, displayName, searchAirports } from '@/lib/airports/catalog'
import type { Airport } from '@/types'
import { useAppData } from '@/app/AppDataContext'

interface Props {
  id: string
  value: Airport | null
  onChange: (airport: Airport | null) => void
  invalid?: boolean
  describedBy?: string
  placeholder?: string
}

function airportSummary(a: Airport): string {
  return `${a.iata} · ${displayName(a)}`
}

export function AirportCombobox({ id, value, onChange, invalid, describedBy, placeholder = '搜索三字码、城市或机场名' }: Props) {
  const { catalog, catalogError, retryCatalog } = useAppData()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const results = useMemo(() => (catalog ? searchAirports(catalog.all, query, 30) : []), [catalog, query])

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn('h-9 w-full justify-between px-3 font-normal', !value && 'text-muted-foreground')}
        >
          <span className="truncate">{value ? airportSummary(value) : '选择机场'}</span>
          <ChevronsUpDown className="opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,26rem)] p-0" align="start">
        <Command shouldFilter={false} label="机场搜索">
          <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} aria-label="搜索机场" />
          <CommandList>
            {!catalog && !catalogError && (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                正在加载机场数据…
              </div>
            )}
            {catalogError && (
              <div className="space-y-2 p-4 text-sm" role="alert">
                <p className="text-destructive">机场数据加载失败。</p>
                <Button size="sm" variant="outline" onClick={retryCatalog}>
                  <RefreshCw aria-hidden />
                  重试
                </Button>
              </div>
            )}
            {catalog && query.trim() === '' && <p className="p-4 text-sm text-muted-foreground">输入如 HKT、普吉、Phuket</p>}
            {catalog && query.trim() !== '' && <CommandEmpty>没有找到匹配的机场</CommandEmpty>}
            {results.length > 0 && (
              <CommandGroup>
                {results.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={a.id}
                    onSelect={() => {
                      onChange(a)
                      setOpen(false)
                      setQuery('')
                    }}
                    className="items-start gap-3"
                  >
                    <span className="mt-0.5 w-10 shrink-0 font-mono text-sm font-semibold">{a.iata}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{displayName(a)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {displayCity(a)}
                        {a.cityZh && a.city ? ` · ${a.city}` : ''} · {a.countryName ?? a.countryCode}
                        {a.nameZh ? ` · ${a.name}` : ''}
                      </span>
                    </span>
                    <Check className={cn('mt-0.5 shrink-0', value?.iata === a.iata ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
