import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { addLeg, freshStart, legRoutes, stableMapShot } from './helpers'

test.describe('Holiday Flight Map', () => {
  test.beforeEach(async ({ page }) => {
    await freshStart(page)
  })

  test('创建假期、添加 4 段、编辑、重排、删除，刷新后保留', async ({ page }) => {
    await expect(page.getByText('记录你的假日航线')).toBeVisible()
    await page.getByRole('button', { name: '新建假期' }).first().click()
    const dialog = page.getByRole('dialog', { name: '新建假期' })
    // 校验：空标题、结束早于开始
    await dialog.getByRole('button', { name: '创建假期' }).click()
    await expect(dialog.getByText('请填写标题')).toBeVisible()
    await dialog.getByLabel('标题').fill('测试假期')
    await dialog.getByLabel('开始日期').fill('2026-09-26')
    await dialog.getByLabel('结束日期').fill('2026-09-01')
    await dialog.getByRole('button', { name: '创建假期' }).click()
    await expect(dialog.getByText('结束日期不能早于开始日期')).toBeVisible()
    await dialog.getByLabel('结束日期').fill('2026-10-05')
    await dialog.getByRole('button', { name: '创建假期' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('测试假期')

    // 第一段：IATA 精确；后续出发机场预填上一段到达
    await addLeg(page, { q: 'ynz', iata: 'YNZ' }, { q: '仁川', iata: 'ICN' }, '2026-09-26')
    await addLeg(page, null, { q: 'Phuket', iata: 'HKT' }, '2026-09-26')
    await addLeg(page, null, { q: 'ICN', iata: 'ICN' }, '2026-10-02')
    await addLeg(page, null, { q: '香港', iata: 'HKG' }, '2026-10-05')
    expect(await legRoutes(page)).toEqual(['YNZICN', 'ICNHKT', 'HKTICN', 'ICNHKG'])

    // 统计
    const stats = page.getByTestId('stats')
    await expect(stats).toContainText('4')
    await expect(stats).toContainText('km')

    // 同一航段起终点相同被拒绝
    await page.getByRole('button', { name: '添加航段' }).first().click()
    let legDialog = page.getByRole('dialog', { name: '添加航段' })
    await page.getByLabel('到达机场').click()
    await page.getByPlaceholder('搜索三字码、城市或机场名').fill('HKG')
    await page.getByPlaceholder('搜索三字码、城市或机场名').press('Enter')
    await legDialog.getByLabel('出发日期（当地）').fill('2026-10-06')
    await legDialog.getByRole('button', { name: '添加航段' }).click()
    await expect(legDialog.getByText('出发和到达机场不能相同')).toBeVisible()
    await legDialog.getByRole('button', { name: '取消' }).click()

    // 编辑第 2 段：加航班号
    await page.getByTestId('leg-item').nth(1).getByRole('button', { name: '编辑' }).click()
    legDialog = page.getByRole('dialog', { name: '编辑航段' })
    await legDialog.getByLabel('航班号').fill('tg 659')
    await legDialog.getByRole('button', { name: '保存航段' }).click()
    await expect(legDialog).toBeHidden()
    await expect(page.getByTestId('leg-item').nth(1)).toContainText('TG 659')

    // 重排：第 4 段上移
    await page.getByRole('button', { name: '上移第 4 段' }).click()
    await expect.poll(() => legRoutes(page)).toEqual(['YNZICN', 'ICNHKT', 'ICNHKG', 'HKTICN'])

    // 选中联动
    await page.getByTestId('leg-item').nth(1).getByRole('button', { pressed: false }).first().click()
    await expect(page.getByTestId('leg-info')).toContainText('ICN → HKT')
    await expect(page.getByTestId('leg-info')).toContainText('TG 659')

    // 删除第 1 段
    await page.getByTestId('leg-item').first().getByRole('button', { name: '删除' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
    await expect.poll(() => legRoutes(page)).toEqual(['ICNHKT', 'ICNHKG', 'HKTICN'])

    // 刷新后保留
    await page.reload()
    await expect(page.getByTestId('trip-title')).toHaveText('测试假期')
    await expect.poll(() => legRoutes(page)).toEqual(['ICNHKT', 'ICNHKG', 'HKTICN'])
    await expect(page.getByTestId('leg-item').first()).toContainText('TG 659')
  })

  test('示例行程只在点击后创建，刷新不重复；可删除假期', async ({ page }) => {
    await page.reload()
    await expect(page.getByText('记录你的假日航线')).toBeVisible()
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    await expect(page.getByText('示例行程，非真实记录')).toBeVisible()
    expect(await legRoutes(page)).toEqual(['YNZICN', 'ICNHKT', 'HKTICN', 'ICNHKG'])
    await page.reload()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    await page.getByTestId('trip-select').click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '删除假期' }).click()
    await expect(page.getByRole('alertdialog')).toContainText('4')
    await page.getByRole('alertdialog').getByRole('button', { name: '删除假期' }).click()
    await expect(page.getByText('记录你的假日航线')).toBeVisible()
  })

  test('回放：播放、暂停、恢复、变速、拖动、重播', async ({ page }) => {
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    const toggle = page.getByTestId('play-toggle')
    const time = page.locator('[aria-label="航线回放"] .tabular-nums').first()
    const elapsed = async () => Number((await time.textContent())!.match(/([\d.]+)s \//)![1])

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-label', '暂停')
    await page.waitForTimeout(800)
    await toggle.click()
    const paused = await elapsed()
    expect(paused).toBeGreaterThan(0.2)
    await page.waitForTimeout(500)
    expect(await elapsed()).toBe(paused)
    await expect(toggle).toHaveAttribute('aria-label', '继续播放')

    // 恢复不跳回起点
    await toggle.click()
    await page.waitForTimeout(300)
    expect(await elapsed()).toBeGreaterThan(paused)

    // 2× 速度
    await page.getByRole('radio', { name: '2×' }).click()
    const a = await elapsed()
    await page.waitForTimeout(1000)
    const b = await elapsed()
    expect(b - a).toBeGreaterThan(1.4)
    await toggle.click()

    // 拖动进度到末尾附近（键盘操作滑块）
    const slider = page.getByRole('slider', { name: '回放进度' })
    await slider.focus()
    await page.keyboard.press('End')
    await expect(time).toContainText('24.0s / 24.0s')
    await expect(toggle).toHaveAttribute('aria-label', '重新播放')
    await page.keyboard.press('Home')
    await expect(time).toContainText('0.0s / 24.0s')

    // 编辑后重置
    await page.getByRole('button', { name: '从头开始' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '下移第 1 段' }).click()
    await expect(time).toContainText('0.0s / 24.0s')
    await expect(toggle).toHaveAttribute('aria-label', '播放')
  })

  test('备份导出后追加导入，非法文件被拒绝且不改动数据', async ({ page }) => {
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')

    await page.getByRole('button', { name: '备份与恢复' }).click()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: '导出备份（JSON）' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^holiday-flight-map-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const path = await download.path()
    const json = JSON.parse(readFileSync(path, 'utf8'))
    expect(json.schemaVersion).toBe(1)
    expect(json.trips).toHaveLength(1)
    expect(json.legs).toHaveLength(4)
    expect(json.airports.map((a: { iata: string }) => a.iata).sort()).toEqual(['HKG', 'HKT', 'ICN', 'YNZ'])

    // 非法：未来版本
    await page.getByRole('button', { name: '备份与恢复' }).click()
    await page.getByRole('menuitem', { name: '导入备份…' }).click()
    const fileInput = page.getByTestId('backup-file')
    await fileInput.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...json, schemaVersion: 9 })) })
    await expect(page.getByRole('dialog')).toContainText('更新的应用版本')
    // 非法：悬空引用
    const dangling = { ...json, legs: [{ ...json.legs[0], arrivalAirportId: 'missing' }] }
    await fileInput.setInputFiles({ name: 'bad2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dangling)) })
    await expect(page.getByRole('dialog')).toContainText('不存在的机场')
    // 非法：JSON 语法
    await fileInput.setInputFiles({ name: 'bad3.json', mimeType: 'application/json', buffer: Buffer.from('{oops') })
    await expect(page.getByRole('dialog')).toContainText('不是有效的 JSON')

    // 合法：提示重复，追加
    await fileInput.setInputFiles(path)
    await expect(page.getByRole('dialog')).toContainText('将追加 1 个假期、4 个航段')
    await expect(page.getByRole('dialog')).toContainText('似乎已存在')
    await page.getByRole('button', { name: '仍然追加导入' }).click()
    await expect(page.getByRole('dialog')).toContainText('导入完成')
    await page.getByRole('button', { name: '完成' }).click()

    await page.getByTestId('trip-select').click()
    await expect(page.getByRole('option')).toHaveCount(2)
    await page.keyboard.press('Escape')
    expect(await legRoutes(page)).toEqual(['YNZICN', 'ICNHKT', 'HKTICN', 'ICNHKG'])
    await page.reload()
    await page.getByTestId('trip-select').click()
    await expect(page.getByRole('option')).toHaveCount(2)
  })

  test('导出 PNG 海报：尺寸正确、地图可见、主视图不变', async ({ page }) => {
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    // 设置一个播放进度，导出后应保持不变
    const slider = page.getByRole('slider', { name: '回放进度' })
    await slider.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('PageUp')
    const time = page.locator('[aria-label="航线回放"] .tabular-nums').first()
    const timeBefore = await time.textContent()
    const toasts = page.locator('[data-sonner-toast]')
    await expect(toasts).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(500)
    const mask = [page.getByTestId('map-overlay')]
    const before = await stableMapShot(page, mask)

    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 })
    await page.getByRole('button', { name: '导出海报' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('holiday-flight-map-亚洲假期示例-2026-09.png')
    const png = readFileSync(await download.path())
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1600)
    expect(png.readUInt32BE(20)).toBe(1000)
    expect(png.length).toBeGreaterThan(50_000)

    // 在浏览器中解码并检查地图区域内容丰富（非纯色）
    const variety = await page.evaluate(async (b64) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(40, 150, 1520, 680).data
      const set = new Set<number>()
      for (let i = 0; i < d.length; i += 4 * 211) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
      return set.size
    }, png.toString('base64'))
    expect(variety).toBeGreaterThan(30)

    await expect(toasts).toHaveCount(0, { timeout: 15_000 })
    await page.waitForTimeout(500)
    const after = await stableMapShot(page, mask)
    if (!after.equals(before)) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync('test-results/map-before.png', before)
      writeFileSync('test-results/map-after.png', after)
    }
    expect(after.equals(before)).toBe(true)
    expect(await time.textContent()).toBe(timeBefore)
  })

  test('分享：生成海报预览，各平台链接带文案，Mastodon 实例刷新后保留', async ({ page }) => {
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')

    await page.getByRole('button', { name: '分享' }).click()
    const dialog = page.getByRole('dialog', { name: '分享航线图' })
    await expect(dialog.getByRole('img', { name: '海报预览' })).toBeVisible({ timeout: 45_000 })
    await expect(dialog.getByRole('button', { name: '下载图片' })).toBeEnabled()

    const text = dialog.getByLabel('分享文案')
    await expect(text).toHaveValue(/^亚洲假期示例：\d+ 段航班 · .* #HolidayFlightMap$/)
    const encoded = encodeURIComponent(await text.inputValue())
    await expect(dialog.getByRole('link', { name: '发到 X' })).toHaveAttribute('href', `https://x.com/intent/post?text=${encoded}`)
    await expect(dialog.getByRole('link', { name: '发到 Bluesky' })).toHaveAttribute('href', `https://bsky.app/intent/compose?text=${encoded}`)
    await expect(dialog.getByRole('link', { name: '发到 X' })).toHaveAttribute('target', '_blank')

    // 编辑文案后链接随之更新
    await text.fill('我的假期 #test')
    await expect(dialog.getByRole('link', { name: '发到 X' })).toHaveAttribute('href', `https://x.com/intent/post?text=${encodeURIComponent('我的假期 #test')}`)

    // Mastodon：先填实例，非法输入被拒绝
    await dialog.getByRole('button', { name: '发到 Mastodon' }).click()
    const instance = dialog.getByLabel('Mastodon 实例')
    await instance.fill('not a host')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog.getByRole('alert')).toContainText('请输入实例域名')
    await instance.fill('https://Fosstodon.org/@alice')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog.getByRole('link', { name: '发到 Mastodon' })).toHaveAttribute('href', `https://fosstodon.org/share?text=${encodeURIComponent('我的假期 #test')}`)
    await expect(dialog).toContainText('Mastodon 实例：fosstodon.org')

    await page.reload()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    await page.getByRole('button', { name: '分享' }).click()
    await expect(page.getByRole('link', { name: '发到 Mastodon' })).toHaveAttribute('href', /^https:\/\/fosstodon\.org\/share\?text=/)
  })

  test('NRT → LAX：导出动画 GIF（可取消、可解码、帧内容变化）', async ({ page }) => {
    test.setTimeout(180_000) // SwiftShader（软件 WebGL）下每帧读回较慢
    await page.getByRole('button', { name: '新建假期' }).first().click()
    await page.getByRole('dialog').getByLabel('标题').fill('跨太平洋')
    await page.getByRole('dialog').getByRole('button', { name: '创建假期' }).click()
    await addLeg(page, { q: 'NRT', iata: 'NRT' }, { q: 'LAX', iata: 'LAX' }, '2026-11-01')

    const dialog = page.getByRole('dialog', { name: '导出航线动画 GIF' })
    await page.getByRole('button', { name: '导出动画' }).click()
    await expect(dialog).toContainText('1 段航程')

    // 取消：回到选项，不下载
    let downloaded = false
    page.on('download', () => (downloaded = true))
    await dialog.getByRole('button', { name: '生成 GIF' }).click()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog.getByRole('button', { name: '生成 GIF' })).toBeVisible()
    expect(downloaded).toBe(false)

    const downloadPromise = page.waitForEvent('download', { timeout: 160_000 })
    await dialog.getByRole('button', { name: '生成 GIF' }).click()
    await expect(dialog.getByRole('progressbar')).toBeVisible()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('holiday-flight-map-跨太平洋-2026-10.gif')
    await expect(dialog).toContainText('已生成并开始下载')
    const gif = readFileSync(await download.path())
    expect(gif.subarray(0, 6).toString()).toBe('GIF89a')
    expect(gif.readUInt16LE(6)).toBe(640)
    expect(gif.readUInt16LE(8)).toBe(400)
    expect(gif.length).toBeLessThan(5 * 1024 * 1024)

    // 浏览器解码：帧数正确，且起始帧与终点帧内容不同（航线被画出）
    const info = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' })
      await decoder.tracks.ready
      const count = decoder.tracks.selectedTrack!.frameCount
      const read = async (i: number) => {
        const { image } = await decoder.decode({ frameIndex: i })
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight)
        const ctx = c.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        image.close()
        return ctx.getImageData(0, 0, c.width, c.height).data
      }
      const first = await read(0)
      const last = await read(count - 1)
      let diff = 0
      for (let i = 0; i < first.length; i += 4) if (first[i] !== last[i] || first[i + 1] !== last[i + 1] || first[i + 2] !== last[i + 2]) diff++
      return { count, diff }
    }, gif.toString('base64'))
    expect(info.count).toBe(37) // 起始帧 + 3 秒 × 12 fps
    expect(info.diff).toBeGreaterThan(1000)

    // 主地图视角与回放不受影响
    await page.getByRole('button', { name: '完成' }).click()
    await expect(page.locator('[aria-label="航线回放"] .tabular-nums').first()).toContainText('0.0s / 6.0s')
  })
})

test.describe('手机布局', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('390px 无水平溢出，地图与列表可切换', async ({ page }) => {
    await freshStart(page)
    await page.getByRole('tab', { name: /航段/ }).click()
    await page.getByRole('button', { name: '加载示例行程' }).click()
    await expect(page.getByTestId('trip-title')).toHaveText('亚洲假期示例')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.getByTestId('leg-item').first().getByRole('button', { pressed: false }).first().click()
    // 选中后自动切到地图
    await expect(page.getByTestId('leg-info')).toBeVisible()
    await expect(page.getByTestId('play-toggle')).toBeVisible()
    await expect(page.getByTestId('play-toggle')).toBeInViewport()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'test-results/mobile-map.png' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  })
})
