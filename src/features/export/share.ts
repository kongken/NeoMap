import type { Trip } from '@/types'
import type { TripStats } from '@/lib/geo/tripGeometry'

/** 社交平台分享：预填文案 + 各平台发帖页（intent）链接 */

export type SharePlatform = 'x' | 'bluesky' | 'mastodon'

export const SHARE_HASHTAG = '#HolidayFlightMap'
export const MASTODON_INSTANCE_KEY = 'hfm.mastodonInstance'
/** X 单条帖子的加权长度上限；Bluesky（300）与 Mastodon（500）更宽松 */
export const X_MAX_WEIGHT = 280

/** 按 X 的规则粗略计算加权长度：拉丁及常用标点记 1，其余（中日韩、emoji 等）记 2；只会高估 */
export function xWeightedLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037)
    n += light ? 1 : 2
  }
  return n
}

export function buildShareText(trip: Pick<Trip, 'title'>, stats: TripStats): string {
  const body = `${stats.legCount} 段航班 · ${stats.cityCount} 座城市 · 约 ${stats.totalKm.toLocaleString('zh-CN')} km ✈️ ${SHARE_HASHTAG}`
  const title = trip.title.trim()
  if (!title) return body
  const full = `${title}：${body}`
  if (xWeightedLength(full) <= X_MAX_WEIGHT) return full

  // 标题过长：逐字截断，保证默认文案一定能在 X 上发出
  const budget = X_MAX_WEIGHT - xWeightedLength(`…：${body}`)
  let kept = ''
  let used = 0
  for (const ch of title) {
    const w = xWeightedLength(ch)
    if (used + w > budget) break
    kept += ch
    used += w
  }
  return `${kept}…：${body}`
}

/** 各平台的发帖页链接；Mastodon 需要实例域名，缺少时返回 null */
export function shareIntentUrl(platform: SharePlatform, text: string, mastodonInstance?: string | null): string | null {
  const q = encodeURIComponent(text)
  switch (platform) {
    case 'x':
      return `https://x.com/intent/post?text=${q}`
    case 'bluesky':
      return `https://bsky.app/intent/compose?text=${q}`
    case 'mastodon':
      return mastodonInstance ? `https://${mastodonInstance}/share?text=${q}` : null
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * 把用户输入的实例规范化为 host[:port]：
 * 接受 `mastodon.social`、`https://mastodon.social/@alice`、`@alice@fosstodon.org` 等写法；不合法返回 null
 */
export function normalizeMastodonInstance(input: string): string | null {
  let s = input.trim().toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(s)
  if (scheme) {
    if (scheme[1] !== 'https' && scheme[1] !== 'http') return null
    s = s.slice(scheme[0].length)
  }
  s = s.split(/[/?#]/)[0]
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1)

  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(s)
  if (!m) return null
  const [, host, port] = m
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TLD.test(labels.at(-1)!)) return null
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null
  return port ? `${host}:${port}` : host
}

export function loadMastodonInstance(): string | null {
  try {
    const v = localStorage.getItem(MASTODON_INSTANCE_KEY)
    return v ? normalizeMastodonInstance(v) : null
  } catch {
    return null
  }
}

export function saveMastodonInstance(instance: string | null) {
  try {
    if (instance) localStorage.setItem(MASTODON_INSTANCE_KEY, instance)
    else localStorage.removeItem(MASTODON_INSTANCE_KEY)
  } catch {
    // 隐私模式等无法写入时只在本次会话内生效
  }
}
