import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * 默认拦截底图瓦片并返回本地固定图片（见 tests/e2e/helpers.ts），避免外部服务影响稳定性。
 * 设置 E2E_REAL_TILES=1 可使用真实底图做手动验证。
 *
 * 云同步端到端测试（tests/e2e/sync.spec.ts）需要 Postgres 与 Redis：
 *   (cd server && docker compose up -d --wait)
 *   E2E_SYNC=1 npx playwright test --project sync
 * 会自动启动 API（:18080）、假 OAuth 服务（:9099）和接入 API 的前端（:5174）。
 */
const sync = process.env.E2E_SYNC === '1'
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, channel: process.env.PW_CHANNEL || undefined }

const webServer: NonNullable<PlaywrightTestConfig['webServer']> = [
  {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
]
if (sync) {
  webServer.push(
    {
      command: 'node tests/e2e/support/fake-oauth.mjs',
      url: 'http://localhost:9099/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'go run ./cmd/neomap-api',
      cwd: 'server',
      url: 'http://localhost:18080/healthz',
      env: { PORT: '18080', BUTTERFLY_CONFIG_TYPE: 'file', BUTTERFLY_CONFIG_FILE_PATH: '../tests/e2e/support/config.e2e.yaml' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'npm run dev -- --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: { VITE_API_BASE_URL: 'http://localhost:18080' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  )
}

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    // 默认使用 SwiftShader（软件 WebGL），结果与机器 GPU 无关，适合 CI；
    // 本地机器负载较高时可设 PW_GPU=1 改用真实 GPU，速度快得多。
    launchOptions: process.env.PW_GPU === '1' ? {} : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [
    // PW_CHANNEL=chrome 可使用本机已安装的 Google Chrome
    { name: 'desktop', use: desktop, testIgnore: /sync\.spec\.ts/ },
    ...(sync ? [{ name: 'sync', use: { ...desktop, baseURL: 'http://localhost:5174' }, testMatch: /sync\.spec\.ts/ }] : []),
  ],
  webServer,
})
