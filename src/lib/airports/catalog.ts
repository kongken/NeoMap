import type { Airport } from '@/types'

/** airports.json 的紧凑格式：[id, iata, name, city, countryCode, lat, lon, rank, nameZh?, cityZh?, aliases?] */
export type AirportRow = [string, string, string, string, string, number, number, number, string?, string?, string[]?]

export interface AirportDataFile {
  meta: { source: string; license: string; fetchedAt: string; count: number; duplicatesDropped: number; strategy: string }
  countries: Record<string, string>
  airports: AirportRow[]
}

export interface CatalogAirport extends Airport {
  rank: number
}

export interface AirportCatalog {
  meta: AirportDataFile['meta']
  all: CatalogAirport[]
  byId: Map<string, CatalogAirport>
  byIata: Map<string, CatalogAirport>
}

export function decodeCatalog(data: AirportDataFile): AirportCatalog {
  const all: CatalogAirport[] = data.airports.map(([id, iata, name, city, countryCode, latitude, longitude, rank, nameZh, cityZh, aliases]) => ({
    id,
    iata,
    name,
    city: city || undefined,
    countryCode,
    countryName: data.countries[countryCode],
    latitude,
    longitude,
    rank,
    nameZh: nameZh || undefined,
    cityZh: cityZh || undefined,
    aliases: aliases && aliases.length ? aliases : undefined,
  }))
  return {
    meta: data.meta,
    all,
    byId: new Map(all.map((a) => [a.id, a])),
    byIata: new Map(all.map((a) => [a.iata, a])),
  }
}

let catalogPromise: Promise<AirportCatalog> | null = null

/** 按需加载内置机场目录（独立 chunk，不阻塞首屏） */
export function loadAirportCatalog(): Promise<AirportCatalog> {
  if (!catalogPromise) {
    catalogPromise = import('@/data/airports.json')
      .then((m) => decodeCatalog(m.default as unknown as AirportDataFile))
      .catch((err) => {
        catalogPromise = null
        throw err
      })
  }
  return catalogPromise
}

export const normalizeQuery = (q: string) => q.trim().toLowerCase()

/**
 * 本地机场搜索。排序：
 * 0 IATA 精确 → 1 中文名/中文城市/别名精确 → 2 IATA 前缀 → 3 城市前缀 → 4 名称前缀
 * → 5 中文包含 → 6 名称或城市包含；同级按机场规模（rank）降序、IATA 升序。
 */
export function searchAirports(all: CatalogAirport[], query: string, limit = 20): CatalogAirport[] {
  const q = normalizeQuery(query)
  if (!q) return []
  const scored: { a: CatalogAirport; s: number }[] = []
  for (const a of all) {
    const s = scoreAirport(a, q)
    if (s !== null) scored.push({ a, s })
  }
  scored.sort((x, y) => x.s - y.s || y.a.rank - x.a.rank || x.a.iata.localeCompare(y.a.iata))
  return scored.slice(0, limit).map((x) => x.a)
}

function scoreAirport(a: CatalogAirport, q: string): number | null {
  const iata = a.iata.toLowerCase()
  if (iata === q) return 0
  const zh = [a.nameZh, a.cityZh, ...(a.aliases ?? [])].filter((s): s is string => !!s).map((s) => s.toLowerCase())
  if (zh.includes(q)) return 1
  if (q.length <= 3 && iata.startsWith(q)) return 2
  const city = (a.city ?? '').toLowerCase()
  const name = a.name.toLowerCase()
  if (city.startsWith(q)) return 3
  if (name.startsWith(q)) return 4
  if (zh.some((s) => s.includes(q))) return 5
  if (q.length >= 2 && (name.includes(q) || city.includes(q))) return 6
  return null
}

/** 用于显示的城市名称：优先中文 */
export function displayCity(a: Pick<Airport, 'city' | 'cityZh' | 'iata'>): string {
  return a.cityZh || a.city || a.iata
}

export function displayName(a: Pick<Airport, 'name' | 'nameZh'>): string {
  return a.nameZh || a.name
}

/** 去掉 CatalogAirport 中的搜索专用字段，得到可持久化的快照 */
export function toSnapshot(a: Airport): Airport {
  const snap: Airport = {
    id: a.id,
    iata: a.iata,
    name: a.name,
    countryCode: a.countryCode,
    latitude: a.latitude,
    longitude: a.longitude,
  }
  if (a.nameZh) snap.nameZh = a.nameZh
  if (a.city) snap.city = a.city
  if (a.cityZh) snap.cityZh = a.cityZh
  if (a.aliases?.length) snap.aliases = [...a.aliases]
  if (a.countryName) snap.countryName = a.countryName
  return snap
}
