import { describe, expect, it } from 'vitest'
import { advance, elapsedFor, fractionToElapsed, LEG_DURATION_MS, locate, MAX_FRAME_DELTA_MS, totalDurationMs } from '@/lib/playback/timeline'

describe('playback timeline', () => {
  it('总时长按航段数计算', () => {
    expect(totalDurationMs(4)).toBe(4 * LEG_DURATION_MS)
    expect(totalDurationMs(0)).toBe(0)
  })

  it('无航段时无法定位', () => {
    expect(locate(0, 0)).toBeNull()
  })

  it('首尾', () => {
    expect(locate(0, 3)).toEqual({ legIndex: 0, legT: 0 })
    expect(locate(totalDurationMs(3), 3)).toEqual({ legIndex: 2, legT: 1 })
    expect(locate(-50, 3)).toEqual({ legIndex: 0, legT: 0 })
    expect(locate(1e9, 3)).toEqual({ legIndex: 2, legT: 1 })
  })

  it('航段边界落在下一段起点', () => {
    expect(locate(LEG_DURATION_MS, 3)).toEqual({ legIndex: 1, legT: 0 })
    expect(locate(2 * LEG_DURATION_MS - 1, 3)!.legIndex).toBe(1)
    expect(locate(2 * LEG_DURATION_MS - 1, 3)!.legT).toBeCloseTo(1, 3)
  })

  it('进度定位往返一致', () => {
    const e = elapsedFor(2, 0.25)
    expect(locate(e, 4)).toEqual({ legIndex: 2, legT: 0.25 })
    expect(fractionToElapsed(0.5, 4)).toBe(2 * LEG_DURATION_MS)
    expect(locate(fractionToElapsed(0.5, 4), 4)).toEqual({ legIndex: 2, legT: 0 })
    expect(fractionToElapsed(2, 4)).toBe(totalDurationMs(4))
    expect(fractionToElapsed(Number.NaN, 4)).toBe(0)
  })

  it('速度映射', () => {
    expect(advance(0, 50, 1, 2).elapsedMs).toBe(50)
    expect(advance(0, 50, 2, 2).elapsedMs).toBe(100)
    expect(advance(0, 50, 0.5, 2).elapsedMs).toBe(25)
  })

  it('大帧间隔被限幅，避免突跳', () => {
    expect(advance(0, 5000, 1, 2).elapsedMs).toBe(MAX_FRAME_DELTA_MS)
    expect(advance(0, -10, 1, 2).elapsedMs).toBe(0)
  })

  it('到达终点后停止', () => {
    const r = advance(totalDurationMs(2) - 10, 50, 1, 2)
    expect(r).toEqual({ elapsedMs: totalDurationMs(2), done: true })
  })
})
