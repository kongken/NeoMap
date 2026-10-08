import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { advance, fractionToElapsed, locate, totalDurationMs, type Speed } from '@/lib/playback/timeline'
import { pathUntil, pointAtDistance } from '@/lib/geo/greatCircle'
import type { TripGeometry } from '@/lib/geo/tripGeometry'
import type { PlaneState } from '@/features/map/routeLayers'

export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'ended'

export interface Playback {
  status: PlaybackStatus
  elapsedMs: number
  totalMs: number
  speed: Speed
  activeLegId: string | null
  plane: PlaneState | null
  canPlay: boolean
  play: () => void
  pause: () => void
  restart: () => void
  stop: () => void
  setSpeed: (s: Speed) => void
  seekFraction: (f: number) => void
}

/**
 * 回放状态机。geometry 的 resetKey 变化（编辑/删除/重排/切换假期）时停止并重置，
 * 保证不引用已删除航段。使用 requestAnimationFrame 与 performance.now 单调时间。
 */
export function usePlayback(geometry: TripGeometry, resetKey: string): Playback {
  const legCount = geometry.legs.length
  const totalMs = totalDurationMs(legCount)
  const [status, setStatus] = useState<PlaybackStatus>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [speed, setSpeed] = useState<Speed>(1)

  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const elapsedRef = useRef(0)
  const speedRef = useRef<Speed>(1)
  const legCountRef = useRef(legCount)
  const tickRef = useRef<(ts: number) => void>(() => {})
  useEffect(() => {
    speedRef.current = speed
  }, [speed])
  useEffect(() => {
    legCountRef.current = legCount
  }, [legCount])

  const cancelFrame = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    lastTsRef.current = null
  }, [])

  // 动画帧：通过 ref 自我调度，避免回调引用自身
  useEffect(() => {
    tickRef.current = (ts: number) => {
      const last = lastTsRef.current
      lastTsRef.current = ts
      const dt = last === null ? 0 : ts - last
      const r = advance(elapsedRef.current, dt, speedRef.current, legCountRef.current)
      elapsedRef.current = r.elapsedMs
      setElapsedMs(r.elapsedMs)
      if (r.done) {
        rafRef.current = null
        lastTsRef.current = null
        setStatus('ended')
        return
      }
      rafRef.current = requestAnimationFrame((t) => tickRef.current(t))
    }
  }, [])
  const tick = useCallback((ts: number) => tickRef.current(ts), [])

  const play = useCallback(() => {
    if (legCountRef.current === 0) return
    if (elapsedRef.current >= totalDurationMs(legCountRef.current)) {
      elapsedRef.current = 0
      setElapsedMs(0)
    }
    cancelFrame()
    setStatus('playing')
    rafRef.current = requestAnimationFrame(tick)
  }, [cancelFrame, tick])

  const pause = useCallback(() => {
    cancelFrame()
    setStatus((s) => (s === 'playing' ? 'paused' : s))
  }, [cancelFrame])

  const stop = useCallback(() => {
    cancelFrame()
    elapsedRef.current = 0
    setElapsedMs(0)
    setStatus('idle')
  }, [cancelFrame])

  const restart = useCallback(() => {
    cancelFrame()
    elapsedRef.current = 0
    setElapsedMs(0)
    if (legCountRef.current === 0) return
    setStatus('playing')
    rafRef.current = requestAnimationFrame(tick)
  }, [cancelFrame, tick])

  const seekFraction = useCallback((f: number) => {
    const e = fractionToElapsed(f, legCountRef.current)
    elapsedRef.current = e
    lastTsRef.current = null
    setElapsedMs(e)
    setStatus((s) => {
      if (s === 'playing') return s
      if (e >= totalDurationMs(legCountRef.current)) return 'ended'
      return 'paused'
    })
  }, [])

  // 数据变化：停止并重置
  useEffect(() => {
    stop()
  }, [resetKey, stop])

  // 切到后台自动暂停；恢复前台不自动继续，也不突跳
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [pause])

  // 卸载时清理动画循环
  useEffect(() => cancelFrame, [cancelFrame])

  const pos = status === 'idle' ? null : locate(elapsedMs, legCount)
  const leg = pos ? geometry.legs[pos.legIndex] : undefined

  const legT = pos?.legT ?? null
  const plane = useMemo<PlaneState | null>(() => {
    if (legT === null || !leg) return null
    const km = legT * leg.route.totalKm
    const p = pointAtDistance(leg.route, km)
    return { position: p.position, bearing: p.bearing, trail: pathUntil(leg.route, km), color: leg.color }
  }, [legT, leg])

  return {
    status,
    elapsedMs,
    totalMs,
    speed,
    activeLegId: leg?.leg.id ?? null,
    plane,
    canPlay: legCount > 0,
    play,
    pause,
    restart,
    stop,
    setSpeed,
    seekFraction,
  }
}
