import type { StyleSpecification } from 'maplibre-gl'

/**
 * 地图服务配置。OSM 是地理数据来源，MapLibre 是渲染引擎，瓦片服务需单独配置。
 *
 * 优先级（互斥）：
 * 1. VITE_MAP_STYLE_URL：完整 MapLibre style JSON 地址。署名取自 style 中各数据源的 attribution。
 * 2. VITE_MAP_TILE_URL：自定义 raster XYZ 模板（{z}/{x}/{y}），配合 VITE_MAP_TILE_ATTRIBUTION、VITE_MAP_TILE_MAX_ZOOM。
 * 3. 默认：OSM 标准 raster 瓦片（仅适合本地低流量开发，公共部署前请替换）。
 *
 * 注意：所有 VITE_* 变量都会打包进浏览器代码，只能放公开配置或限制域名的公开 token。
 */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

export type MapConfig =
  | { kind: 'style'; styleUrl: string; extraAttribution?: string }
  | { kind: 'raster'; tileUrl: string; attribution: string; maxZoom: number; isDefaultOsm: boolean }

export function readMapConfig(env: Record<string, string | undefined> = import.meta.env): MapConfig {
  const styleUrl = env.VITE_MAP_STYLE_URL?.trim()
  if (styleUrl) return { kind: 'style', styleUrl, extraAttribution: env.VITE_MAP_TILE_ATTRIBUTION?.trim() || undefined }
  const tileUrl = env.VITE_MAP_TILE_URL?.trim()
  if (tileUrl) {
    const maxZoom = Number(env.VITE_MAP_TILE_MAX_ZOOM)
    return {
      kind: 'raster',
      tileUrl,
      attribution: env.VITE_MAP_TILE_ATTRIBUTION?.trim() || OSM_ATTRIBUTION,
      maxZoom: Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : 19,
      isDefaultOsm: false,
    }
  }
  return { kind: 'raster', tileUrl: OSM_TILE_URL, attribution: OSM_ATTRIBUTION, maxZoom: 19, isDefaultOsm: true }
}

export const BASEMAP_SOURCE = 'basemap'
const BACKGROUND = '#dbeafe'

export function rasterStyle(config: Extract<MapConfig, { kind: 'raster' }>): StyleSpecification {
  return {
    version: 8,
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'raster',
        tiles: [config.tileUrl],
        tileSize: 256,
        maxzoom: config.maxZoom,
        attribution: `<a href="${OSM_COPYRIGHT_URL}" target="_blank" rel="noopener">${escapeHtml(config.attribution)}</a>`,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } },
      { id: 'basemap', type: 'raster', source: BASEMAP_SOURCE, paint: { 'raster-saturation': -0.25 } },
    ],
  }
}

/** 无底图样式：仅用于用户主动选择的「无底图」海报 */
export function blankStyle(): StyleSpecification {
  return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f7' } }] }
}

export function mapStyleFor(config: MapConfig): string | StyleSpecification {
  return config.kind === 'style' ? config.styleUrl : rasterStyle(config)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 将 HTML 署名转为纯文本 */
export function stripHtml(s: string): string {
  const doc = new DOMParser().parseFromString(s, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function isWebglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    // MapLibre GL JS v6 仅支持 WebGL2
    return !!canvas.getContext('webgl2')
  } catch {
    return false
  }
}
