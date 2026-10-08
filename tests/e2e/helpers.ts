import { deflateSync } from 'node:zlib'
import { expect, type Page } from '@playwright/test'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** 生成 256×256 的本地「底图」瓦片：带网格与渐变，便于判断地图非空 */
export function fakeTile(seed = 0): Buffer {
  const size = 256
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const grid = x % 32 === 0 || y % 32 === 0
      const o = y * (size * 3 + 1) + 1 + x * 3
      raw[o] = grid ? 160 : 200 + ((x + seed * 13) % 40)
      raw[o + 1] = grid ? 180 : 220 + ((y + seed * 7) % 30)
      raw[o + 2] = grid ? 200 : 235
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export async function interceptTiles(page: Page) {
  if (process.env.E2E_REAL_TILES === '1') return
  const tiles = [0, 1, 2, 3].map(fakeTile)
  let n = 0
  await page.route('https://tile.openstreetmap.org/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: tiles[n++ % tiles.length], headers: { 'access-control-allow-origin': '*' } }),
  )
}

export async function freshStart(page: Page) {
  await interceptTiles(page)
  await page.goto('/')
  await page.evaluate(async () => {
    localStorage.clear()
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('holiday-flight-map')
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    })
  })
  await page.reload()
}

export async function chooseAirport(page: Page, fieldLabel: string, query: string, iata: string) {
  await page.getByLabel(fieldLabel).click()
  const input = page.getByPlaceholder('搜索三字码、城市或机场名')
  await input.fill(query)
  // 键盘选择：首个结果应为精确匹配
  await expect(page.getByRole('option').first()).toContainText(iata)
  await input.press('Enter')
  await expect(page.getByLabel(fieldLabel)).toContainText(iata)
}

export async function addLeg(page: Page, from: { q: string; iata: string } | null, to: { q: string; iata: string }, date: string) {
  await page.getByRole('button', { name: '添加航段' }).first().click()
  const dialog = page.getByRole('dialog', { name: '添加航段' })
  await expect(dialog).toBeVisible()
  if (from) await chooseAirport(page, '出发机场', from.q, from.iata)
  await chooseAirport(page, '到达机场', to.q, to.iata)
  await dialog.getByLabel('出发日期（当地）').fill(date)
  await dialog.getByRole('button', { name: '添加航段' }).click()
  await expect(dialog).toBeHidden()
}

export async function legRoutes(page: Page) {
  return page.getByTestId('leg-item').evaluateAll((els) => els.map((el) => (el.querySelector('.font-mono')?.textContent ?? '').replace(/\s+/g, '')))
}
