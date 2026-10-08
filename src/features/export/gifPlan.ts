import type { LngLat } from '@/types'

/** GIF 动画的纯计算部分（帧计划、屏幕坐标插值、帧差），便于单元测试 */

export const GIF_FPS = 12
/** 动画总时长上限（秒），航段多时每段相应缩短 */
export const GIF_MAX_ANIMATION_SEC = 18
export const GIF_LEG_SEC = { min: 1.2, max: 3 }
export const GIF_START_HOLD_MS = 700
export const GIF_END_HOLD_MS = 2500

export const GIF_SIZES = {
  small: { width: 640, height: 400, label: '640 × 400（较小文件）' },
  large: { width: 960, height: 600, label: '960 × 600（更清晰）' },
} as const
export type GifSize = keyof typeof GIF_SIZES

export interface GifFrame {
  /** -1 表示起始画面（尚未出发） */
  legIndex: number
  /** 当前航段进度 0..1 */
  t: number
  /** 此帧显示时长（毫秒，GIF 精度为 10ms） */
  delayMs: number
}

export function legSeconds(legCount: number): number {
  if (legCount <= 0) return 0
  return Math.min(GIF_LEG_SEC.max, Math.max(GIF_LEG_SEC.min, GIF_MAX_ANIMATION_SEC / legCount))
}

/**
 * 帧计划：起始停留 → 按 order 逐段飞行（每段从起点开始，不画段间连线）→ 终点停留。
 * 每段的最后一帧 t=1，保证航段完整画出。
 */
export function planGifFrames(legCount: number, fps = GIF_FPS): GifFrame[] {
  if (legCount <= 0) return []
  const frameMs = Math.round(1000 / fps / 10) * 10
  const perLeg = Math.max(2, Math.round(legSeconds(legCount) * fps))
  const frames: GifFrame[] = [{ legIndex: -1, t: 0, delayMs: GIF_START_HOLD_MS }]
  for (let leg = 0; leg < legCount; leg++) {
    for (let i = 1; i <= perLeg; i++) frames.push({ legIndex: leg, t: i / perLeg, delayMs: frameMs })
  }
  frames[frames.length - 1] = { ...frames[frames.length - 1], delayMs: GIF_END_HOLD_MS }
  return frames
}

type Project = (p: LngLat) => [number, number]

/**
 * 为一条展开经度的航线选择世界副本偏移（±360°·k），使其落在画布中心附近，
 * 然后投影为屏幕坐标。MapLibre 的 project 不回绕经度，跨经线航线需要这一步。
 */
export function projectLeg(unwrapped: LngLat[], project: Project, size: { width: number; height: number }): [number, number][] {
  if (unwrapped.length === 0) return []
  const mid = unwrapped[Math.floor(unwrapped.length / 2)]
  const cx = size.width / 2
  const cy = size.height / 2
  let bestK = 0
  let best = Infinity
  for (let k = -2; k <= 2; k++) {
    const [x, y] = project([mid[0] + 360 * k, mid[1]])
    const d = Math.hypot(x - cx, y - cy)
    if (Number.isFinite(d) && d < best) {
      best = d
      bestK = k
    }
  }
  return unwrapped.map(([lng, lat]) => project([lng + 360 * bestK, lat]))
}

export interface ScreenPoint {
  x: number
  y: number
  /** 屏幕上的行进方向（弧度，0 = 向上，顺时针） */
  angle: number
}

/** 按累计距离在屏幕折线上取点；参数化与应用内回放一致（按地理距离） */
export function screenPointAt(pts: [number, number][], cumulativeKm: number[], km: number): ScreenPoint {
  const n = pts.length
  if (n === 0) return { x: 0, y: 0, angle: 0 }
  if (n === 1) return { x: pts[0][0], y: pts[0][1], angle: 0 }
  const total = cumulativeKm[n - 1]
  const d = Math.min(total, Math.max(0, km))
  let i = 1
  while (i < n - 1 && cumulativeKm[i] < d) i++
  const a = pts[i - 1]
  const b = pts[i]
  const seg = cumulativeKm[i] - cumulativeKm[i - 1]
  const t = seg > 0 ? (d - cumulativeKm[i - 1]) / seg : 0
  const angle = Math.atan2(b[0] - a[0], -(b[1] - a[1]))
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Number.isFinite(angle) ? angle : 0 }
}

/** 屏幕折线从起点到指定距离的部分 */
export function screenPathUntil(pts: [number, number][], cumulativeKm: number[], km: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < pts.length && cumulativeKm[i] < km; i++) out.push(pts[i])
  const p = screenPointAt(pts, cumulativeKm, km)
  out.push([p.x, p.y])
  return out
}

/**
 * 帧差：与上一帧相同的像素改为透明索引（配合 dispose=1 保留上一帧），
 * 大幅减小 GIF 体积。返回新数组，不修改输入。
 */
export function markUnchangedTransparent(prev: Uint8Array, cur: Uint8Array, transparentIndex: number): Uint8Array {
  const out = new Uint8Array(cur.length)
  for (let i = 0; i < cur.length; i++) out[i] = cur[i] === prev[i] ? transparentIndex : cur[i]
  return out
}
