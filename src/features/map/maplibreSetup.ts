import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

// MapLibre v6 默认按 import.meta.url 推算 worker 地址，经 Vite 预构建 / 打包后会失效；
// 这里显式指定由 Vite 输出的 worker 文件地址（开发与生产构建均适用）。
setWorkerUrl(workerUrl)
