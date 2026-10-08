import type { Trip } from '@/types'
import type { TripGeometry, TripStats } from '@/lib/geo/tripGeometry'
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL } from '@/features/map/mapConfig'
import { assertNotBlank, canvasToBlob, ellipsize, EXPORT_FONT as FONT, ExportError, formatDateRange, renderExportMap, withTimeout } from './exportMap'

export const POSTER_WIDTH = 1600
export const POSTER_HEIGHT = 1000
const MAP_BOX = { x: 40, y: 150, w: 1520, h: 680 }

export interface PosterInput {
  trip: Trip
  geometry: TripGeometry
  stats: TripStats
  /** true：用户主动选择「无底图」海报 */
  withoutBasemap?: boolean
}

export async function renderPoster({ trip, geometry, stats, withoutBasemap = false }: PosterInput): Promise<Blob> {
  if (geometry.legs.length === 0) throw new ExportError('当前假期还没有可绘制的航段')
  await withTimeout(document.fonts.ready.then(() => undefined), 5000, '字体加载超时').catch(() => undefined)

  const { canvas: mapCanvas, attributions, cleanup } = await renderExportMap(geometry, { width: MAP_BOX.w, height: MAP_BOX.h, padding: 70, withoutBasemap, label: '海报' })
  try {
    const poster = document.createElement('canvas')
    poster.width = POSTER_WIDTH
    poster.height = POSTER_HEIGHT
    const ctx = poster.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new ExportError('浏览器无法创建画布')

    // 背景
    ctx.fillStyle = '#f8fafc'
    ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT)
    ctx.fillStyle = '#2563eb'
    ctx.fillRect(0, 0, POSTER_WIDTH, 8)

    // 标题
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#0f172a'
    ctx.font = `700 50px ${FONT}`
    ctx.fillText(ellipsize(ctx, trip.title, 1100), 40, 84)
    const range = formatDateRange(trip)
    ctx.fillStyle = '#475569'
    ctx.font = `400 24px ${FONT}`
    ctx.fillText(range || '　', 40, 126)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#2563eb'
    ctx.font = `600 22px ${FONT}`
    ctx.fillText('Holiday Flight Map · 假日飞行航线图', POSTER_WIDTH - 40, 84)
    ctx.textAlign = 'left'

    // 地图
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h, 18)
    ctx.clip()
    ctx.drawImage(mapCanvas, MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h)
    ctx.restore()
    assertNotBlank(ctx, MAP_BOX, withoutBasemap)
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.roundRect(MAP_BOX.x, MAP_BOX.y, MAP_BOX.w, MAP_BOX.h, 18)
    ctx.stroke()

    if (withoutBasemap) {
      ctx.fillStyle = 'rgba(15,23,42,0.75)'
      ctx.beginPath()
      ctx.roundRect(MAP_BOX.x + 16, MAP_BOX.y + 16, 120, 36, 8)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `600 18px ${FONT}`
      ctx.fillText('无底图', MAP_BOX.x + 46, MAP_BOX.y + 41)
    }

    // 统计
    const statItems: [string, string][] = [
      ['航段', String(stats.legCount)],
      ['机场', String(stats.airportCount)],
      ['到达城市', String(stats.cityCount)],
      ['估算飞行距离', `${stats.totalKm.toLocaleString('zh-CN')} km`],
    ]
    const statY = MAP_BOX.y + MAP_BOX.h + 62
    statItems.forEach(([label, value], i) => {
      const x = 40 + i * 260
      ctx.fillStyle = '#0f172a'
      ctx.font = `700 40px ${FONT}`
      ctx.fillText(value, x, statY)
      ctx.fillStyle = '#64748b'
      ctx.font = `400 20px ${FONT}`
      ctx.fillText(label, x, statY + 32)
    })

    // 说明（右侧）
    ctx.textAlign = 'right'
    ctx.fillStyle = '#334155'
    ctx.font = `600 20px ${FONT}`
    ctx.fillText('示意航线 · 距离为估算', POSTER_WIDTH - 40, statY - 10)
    ctx.fillStyle = '#64748b'
    ctx.font = `400 16px ${FONT}`
    ctx.fillText('不代表实际飞行路径', POSTER_WIDTH - 40, statY + 22)
    ctx.textAlign = 'left'

    // 署名（底部整行）：保留所有底图来源署名
    const extra = attributions.filter((a) => !a.includes(OSM_ATTRIBUTION))
    const credit = withoutBasemap
      ? '无底图海报（未包含地图底图） · 机场坐标：OurAirports'
      : [`底图 ${OSM_ATTRIBUTION} ${OSM_COPYRIGHT_URL}`, ...extra, '机场坐标：OurAirports'].join(' · ')
    ctx.fillStyle = '#64748b'
    ctx.font = `400 15px ${FONT}`
    ctx.fillText(ellipsize(ctx, credit, POSTER_WIDTH - 80), 40, POSTER_HEIGHT - 22)

    const blob = await canvasToBlob(poster, 'image/png')
    return blob
  } finally {
    cleanup()
  }
}
