import { describe, expect, it } from 'vitest'
import { decodeCatalog, searchAirports, type AirportDataFile } from '@/lib/airports/catalog'
import data from '@/data/airports.json'

const catalog = decodeCatalog(data as unknown as AirportDataFile)
const top = (q: string) => searchAirports(catalog.all, q, 5)[0]?.iata

describe('airport catalog', () => {
  it('包含必需机场', () => {
    for (const c of ['SZX', 'HKG', 'YNZ', 'ICN', 'HKT', 'NRT', 'SIN', 'LHR', 'JFK', 'LAX', 'SYD', 'AKL']) {
      const a = catalog.byIata.get(c)
      expect(a, c).toBeDefined()
      expect(a!.nameZh, c).toBeTruthy()
      expect(Math.abs(a!.latitude)).toBeLessThanOrEqual(90)
    }
  })

  it('IATA 精确匹配优先，忽略大小写与首尾空格', () => {
    expect(top('hkt')).toBe('HKT')
    expect(top('  LAX ')).toBe('LAX')
    expect(top('sin')).toBe('SIN')
  })

  it('英文名称 / 城市搜索', () => {
    expect(top('Heathrow')).toBe('LHR')
    expect(searchAirports(catalog.all, 'Incheon', 5).map((a) => a.iata)).toContain('ICN')
    expect(searchAirports(catalog.all, 'phuket', 5).map((a) => a.iata)).toContain('HKT')
  })

  it('中文别名搜索', () => {
    expect(top('仁川')).toBe('ICN')
    expect(top('普吉岛')).toBe('HKT')
    expect(top('樟宜')).toBe('SIN')
    expect(top('盐城')).toBe('YNZ')
    expect(searchAirports(catalog.all, '东京', 5).map((a) => a.iata)).toEqual(expect.arrayContaining(['NRT', 'HND']))
  })

  it('无结果', () => {
    expect(searchAirports(catalog.all, 'zzzzqqq')).toEqual([])
    expect(searchAirports(catalog.all, '   ')).toEqual([])
  })
})
