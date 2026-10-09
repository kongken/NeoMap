import { describe, expect, it } from 'vitest'
import { buildShareText, normalizeMastodonInstance, shareIntentUrl, X_MAX_WEIGHT, xWeightedLength } from '@/features/export/share'
import type { TripStats } from '@/lib/geo/tripGeometry'

const stats: TripStats = { legCount: 4, airportCount: 5, cityCount: 3, totalKm: 8420 }

describe('buildShareText', () => {
  it('包含标题、航段、城市、距离与话题标签', () => {
    expect(buildShareText({ title: '东京之旅' }, stats)).toBe('东京之旅：4 段航班 · 3 座城市 · 约 8,420 km ✈️ #HolidayFlightMap')
  })

  it('标题首尾空白被去掉，空标题省略前缀', () => {
    expect(buildShareText({ title: '  ' }, stats)).toBe('4 段航班 · 3 座城市 · 约 8,420 km ✈️ #HolidayFlightMap')
  })

  it('超长标题被截断，整体不超过 X 的长度上限', () => {
    const text = buildShareText({ title: '很长的假期'.repeat(100) }, stats)
    expect(xWeightedLength(text)).toBeLessThanOrEqual(X_MAX_WEIGHT)
    expect(text).toContain('…：4 段航班')
    expect(text.endsWith('#HolidayFlightMap')).toBe(true)
  })
})

describe('xWeightedLength', () => {
  it('拉丁字符记 1，中日韩字符记 2', () => {
    expect(xWeightedLength('abc')).toBe(3)
    expect(xWeightedLength('东京')).toBe(4)
  })
})

describe('shareIntentUrl', () => {
  const text = '东京 & 大阪 #HolidayFlightMap'

  it('X', () => {
    expect(shareIntentUrl('x', text)).toBe(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
  })

  it('Bluesky', () => {
    expect(shareIntentUrl('bluesky', text)).toBe(`https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`)
  })

  it('Mastodon 使用给定实例', () => {
    expect(shareIntentUrl('mastodon', text, 'mastodon.social')).toBe(`https://mastodon.social/share?text=${encodeURIComponent(text)}`)
  })

  it('Mastodon 缺少实例时返回 null', () => {
    expect(shareIntentUrl('mastodon', text)).toBeNull()
  })
})

describe('normalizeMastodonInstance', () => {
  it.each([
    ['mastodon.social', 'mastodon.social'],
    ['  Mastodon.Social  ', 'mastodon.social'],
    ['https://mastodon.social/', 'mastodon.social'],
    ['https://mastodon.social/@alice', 'mastodon.social'],
    ['@alice@fosstodon.org', 'fosstodon.org'],
    ['alice@fosstodon.org', 'fosstodon.org'],
    ['m.cmx.im:8443', 'm.cmx.im:8443'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMastodonInstance(input)).toBe(expected)
  })

  it.each(['', 'localhost', 'not a host', 'javascript:alert(1)', 'a..b', '-bad.com', 'ftp://files.example.com'])('拒绝 %j', (input) => {
    expect(normalizeMastodonInstance(input)).toBeNull()
  })
})
