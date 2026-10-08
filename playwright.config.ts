import { defineConfig, devices } from '@playwright/test'

/**
 * 默认拦截底图瓦片并返回本地固定图片（见 tests/e2e/helpers.ts），避免外部服务影响稳定性。
 * 设置 E2E_REAL_TILES=1 可使用真实底图做手动验证。
 */
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
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, channel: process.env.PW_CHANNEL || undefined } },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
