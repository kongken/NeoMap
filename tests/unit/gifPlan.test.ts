import { describe, expect, it } from 'vitest'
import {
  GIF_END_HOLD_MS,
  GIF_FPS,
  GIF_LEG_SEC,
  GIF_START_HOLD_MS,
  legSeconds,
  markUnchangedTransparent,
  planGifFrames,
  projectLeg,
  screenPathUntil,
  screenPointAt,
} from '@/features/export/gifPlan'
import { greatCircleRoute } from '@/lib/geo/greatCircle'
import type { LngLat } from '@/types'

describe('planGifFrames', () => {
  it('无航段时没有帧', () => {
    expect(planGifFrames(0)).toEqual([])
  })

  it('起始停留 → 按顺序逐段 → 终点停留', () => {
    const frames = planGifFrames(4)
    expect(frames[0]).toEqual({ legIndex: -1, t: 0, delayMs: GIF_START_HOLD_MS })
    expect(frames.at(-1)).toMatchObject({ legIndex: 3, t: 1, delayMs: GIF_END_HOLD_MS })
    // legIndex 单调不减，每段最后一帧 t = 1
    for (let i = 1; i < frames.length; i++) expect(frames[i].legIndex).toBeGreaterThanOrEqual(frames[i - 1].legIndex)
    for (let leg = 0; leg < 4; leg++) {
      const ofLeg = frames.filter((f) => f.legIndex === leg)
      expect(ofLeg.at(-1)!.t).toBe(1)
      expect(ofLeg[0].t).toBeGreaterThan(0)
      for (let i = 1; i < ofLeg.length; i++) expect(ofLeg[i].t).toBeGreaterThan(ofLeg[i - 1].t)
    }
  })

  it('每段时长被限制在区间内，总帧数随航段数受控', () => {
    expect(legSeconds(1)).toBe(GIF_LEG_SEC.max)
    expect(legSeconds(100)).toBe(GIF_LEG_SEC.min)
    const perLeg = (n: number) => planGifFrames(n).filter((f) => f.legIndex === 0).length
    expect(perLeg(1)).toBe(Math.round(GIF_LEG_SEC.max * GIF_FPS))
    expect(perLeg(30)).toBe(Math.round(GIF_LEG_SEC.min * GIF_FPS))
  })

  it('帧间隔为 10ms 的整数倍（GIF 精度）', () => {
    for (const f of planGifFrames(3)) expect(f.delayMs % 10).toBe(0)
  })
})

describe('projectLeg', () => {
  // 模拟一个视图中心经度已被标准化到 -170° 的墨卡托投影（不回绕经度）
  const W = 640
  const H = 400
  const centerLng = -170
  const project = ([lng, lat]: LngLat): [number, number] => [W / 2 + (lng - centerLng) * 3, H / 2 - lat * 3]

  it('跨经线航线被平移到画布中心附近的世界副本', () => {
    const route = greatCircleRoute([140.38871, 35.76858], [-118.408, 33.9425]) // NRT → LAX，展开经度 140 → 241
    const pts = projectLeg(route.unwrapped, project, { width: W, height: H })
    // 选择 k = -1 后，起点约在 -220°（相对中心 -50°），终点约在 -118°
    expect(pts[0][0]).toBeCloseTo(W / 2 + (140.38871 - 360 - centerLng) * 3, 6)
    for (const [x] of pts) expect(Math.abs(x - W / 2)).toBeLessThan(W)
    // 屏幕上连续，无大跳跃
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThan(20)
  })

  it('空路径返回空数组', () => {
    expect(projectLeg([], project, { width: W, height: H })).toEqual([])
  })
})

describe('screen path sampling', () => {
  const pts: [number, number][] = [
    [0, 100],
    [0, 50],
    [50, 50],
  ]
  const km = [0, 500, 1000]

  it('首尾与中间位置', () => {
    expect(screenPointAt(pts, km, 0)).toMatchObject({ x: 0, y: 100 })
    expect(screenPointAt(pts, km, 1000)).toMatchObject({ x: 50, y: 50 })
    expect(screenPointAt(pts, km, 250)).toMatchObject({ x: 0, y: 75 })
    expect(screenPointAt(pts, km, 9999)).toMatchObject({ x: 50, y: 50 })
  })

  it('朝向：向上为 0，向右为 π/2', () => {
    expect(screenPointAt(pts, km, 250).angle).toBeCloseTo(0, 9)
    expect(screenPointAt(pts, km, 750).angle).toBeCloseTo(Math.PI / 2, 9)
  })

  it('已飞轨迹以当前位置结尾', () => {
    expect(screenPathUntil(pts, km, 750)).toEqual([
      [0, 100],
      [0, 50],
      [25, 50],
    ])
    expect(screenPathUntil(pts, km, 0)).toEqual([[0, 100]])
  })
})

describe('markUnchangedTransparent', () => {
  it('与上一帧相同的像素改为透明索引，不修改输入', () => {
    const prev = Uint8Array.from([1, 2, 3, 4])
    const cur = Uint8Array.from([1, 9, 3, 7])
    const out = markUnchangedTransparent(prev, cur, 255)
    expect([...out]).toEqual([255, 9, 255, 7])
    expect([...cur]).toEqual([1, 9, 3, 7])
  })
})
