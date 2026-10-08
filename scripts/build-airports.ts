/**
 * 从 OurAirports 构建精简机场数据：src/data/airports.json
 *
 * 用法：
 *   npm run build:airports            # 使用缓存（scripts/.cache），没有则下载
 *   npm run build:airports -- --fresh # 强制重新下载
 *
 * 规则：
 * - 仅保留 type 为 large_airport / medium_airport / small_airport 的机场
 *   （排除 closed、heliport、seaplane_base、balloonport）。
 * - iata_code 必须是 3 位大写字母；经纬度必须是有限数且在合法范围内。
 * - 重复 IATA：按 scheduled_service=yes > 机场规模(large>medium>small) > 有 ICAO 代码
 *   > OurAirports 数字 id 较小者 选出唯一一条，其余丢弃并计数。
 * - 合并 src/data/airport-aliases.json 中的中文名、中文城市名和别名。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, 'scripts/.cache')
const OUT = path.join(ROOT, 'src/data/airports.json')
const ALIASES = path.join(ROOT, 'src/data/airport-aliases.json')
const BASE_URL = 'https://davidmegginson.github.io/ourairports-data'

const TYPE_RANK: Record<string, number> = {
  large_airport: 3,
  medium_airport: 2,
  small_airport: 1,
}

/** RFC4180 风格的 CSV 解析（支持引号、转义引号、字段内换行）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function toObjects(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])))
}

async function fetchCached(name: string, fresh: boolean): Promise<string> {
  mkdirSync(CACHE, { recursive: true })
  const file = path.join(CACHE, name)
  if (!fresh && existsSync(file)) return readFileSync(file, 'utf8')
  const res = await fetch(`${BASE_URL}/${name}`)
  if (!res.ok) throw new Error(`下载 ${name} 失败：HTTP ${res.status}`)
  const text = await res.text()
  writeFileSync(file, text)
  return text
}

const round = (n: number) => Math.round(n * 1e5) / 1e5

interface AliasEntry {
  nameZh?: string
  cityZh?: string
  aliases?: string[]
}

async function main() {
  const fresh = process.argv.includes('--fresh')
  const airports = toObjects(parseCsv(await fetchCached('airports.csv', fresh)))
  const countries = toObjects(parseCsv(await fetchCached('countries.csv', fresh)))
  const aliasFile = JSON.parse(readFileSync(ALIASES, 'utf8')) as Record<string, AliasEntry | string>

  const countryNames: Record<string, string> = {}
  for (const c of countries) countryNames[c.code] = c.name

  const best = new Map<string, Record<string, string>>()
  let duplicates = 0
  const score = (a: Record<string, string>) => [
    a.scheduled_service === 'yes' ? 1 : 0,
    TYPE_RANK[a.type] ?? 0,
    a.icao_code ? 1 : 0,
    -Number(a.id),
  ]
  const better = (a: Record<string, string>, b: Record<string, string>) => {
    const sa = score(a)
    const sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i]
    return false
  }

  for (const a of airports) {
    if (!(a.type in TYPE_RANK)) continue
    const iata = a.iata_code.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(iata)) continue
    const lat = Number(a.latitude_deg)
    const lon = Number(a.longitude_deg)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue
    const prev = best.get(iata)
    if (prev) {
      duplicates++
      if (better(a, prev)) best.set(iata, a)
    } else {
      best.set(iata, a)
    }
  }

  // 紧凑元组：[id, iata, name, city, countryCode, lat, lon, rank, nameZh?, cityZh?, aliases?]
  // rank：机场规模(1-3) + 有定期航班(+3)，仅用于搜索排序
  type Row = [string, string, string, string, string, number, number, number, ...unknown[]]
  const rows: Row[] = [...best.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iata, a]) => {
      const row: Row = [
        `oa:${a.id}`,
        iata,
        a.name,
        a.municipality,
        a.iso_country,
        round(Number(a.latitude_deg)),
        round(Number(a.longitude_deg)),
        TYPE_RANK[a.type] + (a.scheduled_service === 'yes' ? 3 : 0),
      ]
      const alias = aliasFile[iata]
      if (alias && typeof alias === 'object') {
        row.push(alias.nameZh ?? '', alias.cityZh ?? '', alias.aliases ?? [])
      }
      return row
    })

  const required = ['SZX', 'HKG', 'YNZ', 'ICN', 'HKT', 'NRT', 'SIN', 'LHR', 'JFK', 'LAX', 'SYD', 'AKL']
  const missing = required.filter((c) => !best.has(c))
  if (missing.length) throw new Error(`缺少必需机场：${missing.join(', ')}`)

  const usedCountries = Object.fromEntries(
    [...new Set(rows.map((r) => r[4]))].sort().map((c) => [c, countryNames[c] ?? c]),
  )

  const out = {
    meta: {
      source: 'OurAirports (https://ourairports.com/data/)',
      license: 'Public Domain',
      fetchedAt: new Date().toISOString().slice(0, 10),
      count: rows.length,
      duplicatesDropped: duplicates,
      strategy:
        'types large/medium/small_airport; valid 3-letter IATA; valid coords; duplicate IATA resolved by scheduled_service > size > has ICAO > lowest id',
    },
    countries: usedCountries,
    airports: rows,
  }
  writeFileSync(OUT, JSON.stringify(out))
  console.log(`写入 ${OUT}：${rows.length} 个机场，丢弃重复 IATA ${duplicates} 条`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
