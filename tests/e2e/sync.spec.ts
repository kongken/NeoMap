import { expect, test, type Page } from '@playwright/test'
import { addLeg, freshStart, legRoutes } from './helpers'

// 两个浏览器上下文模拟两台设备，通过真实 API（Postgres + Redis）与假 OAuth 登录同步。
// 运行方式见 playwright.config.ts（需要 E2E_SYNC=1）。

async function login(page: Page) {
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('menuitem', { name: '使用 GitHub 登录' }).click()
  await page.waitForURL(/localhost:5174/)
  await expect(page.getByTestId('account-button')).toBeVisible()
}

/**
 * 关闭菜单 / 下拉框，并等待关闭动画结束。
 * 关闭后焦点会回到触发按钮；若在动画期间立即再次点击，迟到的焦点回归会把新打开的菜单关掉。
 */
async function closePopup(page: Page, role: 'menu' | 'listbox') {
  await page.keyboard.press('Escape')
  await expect(page.getByRole(role)).toHaveCount(0)
}

/** 打开账号菜单读取同步状态 */
async function syncStatus(page: Page): Promise<string> {
  await page.getByTestId('account-button').click()
  const text = (await page.getByTestId('sync-status').textContent()) ?? ''
  await closePopup(page, 'menu')
  return text
}

async function expectSynced(page: Page) {
  await expect.poll(() => syncStatus(page), { timeout: 20_000 }).toMatch(/^已同步/)
}

async function syncNow(page: Page) {
  await page.getByTestId('account-button').click()
  await page.getByRole('menuitem', { name: '立即同步' }).click()
  // 选择菜单项同样会触发关闭动画与焦点回归
  await expect(page.getByRole('menu')).toHaveCount(0)
}

async function renameTrip(page: Page, title: string) {
  await page.getByRole('button', { name: '编辑假期' }).click()
  const dialog = page.getByRole('dialog', { name: '编辑假期' })
  await dialog.getByLabel('标题').fill(title)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()
}

async function tripTitles(page: Page): Promise<string[]> {
  await page.getByTestId('trip-select').click()
  const titles = (await page.getByRole('option').allInnerTexts()).map((t) => t.replace('（示例）', '').trim()).sort()
  await closePopup(page, 'listbox')
  return titles
}

test('两台设备之间同步：上传、拉取、修改、冲突副本、删除、退出清除', async ({ browser }) => {
  test.setTimeout(240_000)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await freshStart(a)
  await freshStart(b)

  // 设备 A：未登录时创建行程
  const title = `同步测试 ${Date.now()}`
  await a.getByRole('button', { name: '新建假期' }).first().click()
  await a.getByRole('dialog', { name: '新建假期' }).getByLabel('标题').fill(title)
  await a.getByRole('dialog', { name: '新建假期' }).getByRole('button', { name: '创建假期' }).click()
  await addLeg(a, { q: 'NRT', iata: 'NRT' }, { q: 'LAX', iata: 'LAX' }, '2026-11-01')
  await addLeg(a, null, { q: 'AKL', iata: 'AKL' }, '2026-11-05')

  // A 登录：询问是否上传本设备的行程
  await login(a)
  const firstLogin = a.getByRole('alertdialog', { name: '同步本设备上的假期？' })
  await expect(firstLogin).toContainText('1')
  await firstLogin.getByRole('button', { name: '上传到账号' }).click()
  await expectSynced(a)

  // 设备 B：本地没有数据，登录后直接拉取
  await login(b)
  await expect(b.getByRole('alertdialog')).toHaveCount(0)
  await expect(b.getByTestId('trip-title')).toHaveText(title)
  expect(await legRoutes(b)).toEqual(['NRTLAX', 'LAXAKL'])

  // B 修改 → 自动同步 → A 拉取
  await renameTrip(b, `${title}（B 改名）`)
  await expectSynced(b)
  await syncNow(a)
  await expect(a.getByTestId('trip-title')).toHaveText(`${title}（B 改名）`)

  // 冲突：A 离线修改，同时 B 修改并同步；A 恢复网络后保留服务端版本并另存副本
  await ctxA.setOffline(true)
  await renameTrip(a, 'A 离线修改')
  await expect.poll(() => syncStatus(a), { timeout: 20_000 }).toMatch(/暂时无法连接/)
  await renameTrip(b, 'B 在线修改')
  await expectSynced(b)
  await ctxA.setOffline(false)
  await syncNow(a)
  await expect(a.getByText('在其他设备上被修改，本设备的修改已另存为副本')).toBeVisible({ timeout: 20_000 })
  await expectSynced(a)
  expect(await tripTitles(a)).toEqual(['A 离线修改（本设备副本）', 'B 在线修改'])

  // 副本也同步到了 B
  await syncNow(b)
  await expect.poll(() => tripTitles(b), { timeout: 20_000 }).toEqual(['A 离线修改（本设备副本）', 'B 在线修改'])

  // B 删除副本 → A 同步后也消失
  await b.getByTestId('trip-select').click()
  await b.getByRole('option', { name: 'A 离线修改（本设备副本）' }).click()
  await b.getByRole('button', { name: '删除假期' }).click()
  await b.getByRole('alertdialog').getByRole('button', { name: '删除假期' }).click()
  await expectSynced(b)
  await syncNow(a)
  await expect.poll(() => tripTitles(a), { timeout: 20_000 }).toEqual(['B 在线修改'])

  // 刷新后保持登录与数据
  await a.reload()
  await expect(a.getByTestId('trip-title')).toHaveText('B 在线修改')
  await expectSynced(a)

  // A 退出并清除本设备数据；账号中的数据不受影响
  await a.getByTestId('account-button').click()
  await a.getByRole('menuitem', { name: '退出登录' }).click()
  const logout = a.getByRole('alertdialog', { name: '退出登录' })
  await expect(logout).toContainText('1')
  await logout.getByRole('button', { name: '退出登录' }).click()
  await expect(a.getByText('记录你的假日航线')).toBeVisible()
  await expect(a.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await syncNow(b)
  expect(await tripTitles(b)).toEqual(['B 在线修改'])

  await ctxA.close()
  await ctxB.close()
})
