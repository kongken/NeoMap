/** 每个航段的基础演示时长（毫秒，1× 速度）；与实际飞行时长无关 */
export const LEG_DURATION_MS = 6000

export const SPEEDS = [0.5, 1, 2] as const
export type Speed = (typeof SPEEDS)[number]

/** 单帧最大推进量，避免卡顿或后台恢复后突跳 */
export const MAX_FRAME_DELTA_MS = 100

export function totalDurationMs(legCount: number): number {
  return Math.max(0, legCount) * LEG_DURATION_MS
}

export interface TimelinePosition {
  legIndex: number
  /** 当前航段内的进度 0..1 */
  legT: number
}

/**
 * 将全局演示进度（毫秒）映射到航段与航段内进度。
 * 边界处（k * LEG_DURATION_MS）落在第 k 段起点；总时长处停在最后一段终点。
 */
export function locate(elapsedMs: number, legCount: number): TimelinePosition | null {
  if (legCount <= 0) return null
  const total = totalDurationMs(legCount)
  const e = Number.isFinite(elapsedMs) ? Math.min(total, Math.max(0, elapsedMs)) : 0
  if (e >= total) return { legIndex: legCount - 1, legT: 1 }
  const legIndex = Math.floor(e / LEG_DURATION_MS)
  return { legIndex, legT: (e - legIndex * LEG_DURATION_MS) / LEG_DURATION_MS }
}

/** 由航段与航段内进度反推全局进度 */
export function elapsedFor(legIndex: number, legT: number): number {
  return (legIndex + Math.min(1, Math.max(0, legT))) * LEG_DURATION_MS
}

/**
 * 推进一帧：dt 为单调时钟增量（毫秒），按速度缩放并限幅。
 * 返回新的进度及是否已到达终点。
 */
export function advance(elapsedMs: number, dtMs: number, speed: number, legCount: number): { elapsedMs: number; done: boolean } {
  const total = totalDurationMs(legCount)
  const dt = Math.min(MAX_FRAME_DELTA_MS, Math.max(0, Number.isFinite(dtMs) ? dtMs : 0))
  const next = Math.min(total, elapsedMs + dt * speed)
  return { elapsedMs: next, done: next >= total }
}

/** 进度条比例 0..1 → 毫秒 */
export function fractionToElapsed(fraction: number, legCount: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return f * totalDurationMs(legCount)
}
