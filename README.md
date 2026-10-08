# Holiday Flight Map · 假日飞行航线图

一个纯前端的个人旅行记录应用：创建假期、录入航段，在地图上查看机场与**示意航线**（大圆航线），播放飞机沿航线移动的动画，导出 PNG 旅行海报和**航线动画 GIF**，并通过 JSON 备份与恢复数据。

> 示意航线 · 距离为估算。航线由机场坐标计算的大圆路径生成，不代表飞机实际飞行路径。

- 无后端、无登录、无云同步；数据保存在**当前浏览器**（IndexedDB）。
- 机场数据随应用提供（OurAirports，8,798 个有 IATA 代码的机场）；运行时不下载机场数据、不调用地理编码 API。
- 底图通过网络加载（默认 OSM 标准瓦片，可配置替换）。

## 1. 环境与命令

- Node.js **≥ 22.18**（机场构建脚本直接以 Node 运行 TypeScript；开发验证使用 Node 22.22.1）
- npm（已提交 `package-lock.json`）

```bash
npm install
npm run dev            # 开发服务器 http://localhost:5173
npm run build          # 类型检查 + 生产构建，输出到 dist/
npm run preview        # 预览生产构建 http://localhost:4173
npm run typecheck      # TypeScript strict 类型检查
npm run lint           # oxlint
npm test               # Vitest 单元测试（地理计算、回放、导入校验、仓库事务、机场搜索）
npm run test:e2e       # Playwright 浏览器测试（自动启动 dev server）
npm run build:airports # 重新生成机场数据（见第 3 节）
```

Playwright 浏览器：执行 `npx playwright install chromium`，或使用本机已安装的 Google Chrome：`PW_CHANNEL=chrome npm run test:e2e`。
e2e 默认用 SwiftShader（软件 WebGL）渲染地图，结果与机器 GPU 无关；本机负载较高时可能超时，可加 `PW_GPU=1` 改用真实 GPU。

部署静态文件时，服务器需以 `text/javascript` 类型提供 `.mjs` 文件（MapLibre 的 worker 文件）。

## 2. 地图配置

三个概念需要区分：**OpenStreetMap** 是地理数据来源；**MapLibre GL JS** 是浏览器端渲染引擎；**瓦片服务**（谁来提供底图图片 / 矢量瓦片）需要单独配置。

配置在 `src/features/map/mapConfig.ts`，通过环境变量（见 `.env.example`，复制为 `.env.local` 修改）：

| 优先级 | 变量 | 说明 |
| --- | --- | --- |
| 1 | `VITE_MAP_STYLE_URL` | 完整 MapLibre style JSON 地址。设置后忽略下面两项。署名取自 style 中数据源的 `attribution`。 |
| 2 | `VITE_MAP_TILE_URL` (+ `VITE_MAP_TILE_MAX_ZOOM`) | 自定义 raster XYZ 模板，如 `https://tiles.example.com/{z}/{x}/{y}.png` |
| 3 | 未设置 | OSM 标准瓦片 `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |

`VITE_MAP_TILE_ATTRIBUTION`：raster 模式下作为数据源署名；style 模式下作为额外署名追加到海报。

**使用约束**

- 默认的 OSM 标准瓦片只适合本地、低流量开发，需遵守 [OSM 瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)。它不是无限免费的商业托管服务。**公开部署前请更换为有授权的瓦片供应商**，并核对其条款、额度和截图 / 导出权限。
- 本应用不批量下载、不预取、不通过 Service Worker 离线缓存瓦片；地图不能离线使用。
- **所有 `VITE_*` 变量都会打包进浏览器代码**。只能放公开配置，或供应商允许公开、且已限制来源域名的 token；不要放任何服务端密钥。
- 署名：应用内地图显示数据源署名；导出的海报始终包含「© OpenStreetMap contributors」与 <https://www.openstreetmap.org/copyright>，并保留其他供应商的署名。
- 导出海报需要读取地图画布像素，瓦片服务必须返回允许跨域的 CORS 头（`Access-Control-Allow-Origin`），否则导出会提示失败。

## 3. 机场数据

- 来源：[OurAirports](https://ourairports.com/data/) `airports.csv` + `countries.csv`，公共领域数据；获取日期 2026-10-08。
- 生成：`npm run build:airports`（脚本 `scripts/build-airports.ts`）。默认使用 `scripts/.cache/` 中缓存的 CSV，不存在时下载；`npm run build:airports -- --fresh` 强制重新下载。脚本可重复执行，输出确定。
- 输出：`src/data/airports.json`（紧凑元组格式，运行时按需加载为独立 chunk）。
- 过滤规则：
  - 仅保留 `large_airport` / `medium_airport` / `small_airport`（排除 `closed`、直升机场、水上机场、热气球场）；
  - `iata_code` 必须是 3 位大写字母；经纬度必须为有限数且在合法范围内。
- 重复 IATA 处理策略：按「有定期航班 > 机场规模（大>中>小）> 有 ICAO 代码 > OurAirports id 较小」选出一条，其余丢弃（当前数据中 0 条重复）。
- 中文名称 / 城市 / 别名：`src/data/airport-aliases.json`（人工整理，含 SZX、HKG、YNZ、ICN、HKT、NRT、SIN、LHR、JFK、LAX、SYD、AKL 及其他常用机场），构建时合并。新增别名后重新执行 `npm run build:airports`。
- 当前覆盖：8,798 个机场（全球所有在 OurAirports 中有有效 IATA 代码且未关闭的机场）。
- 搜索：IATA（精确匹配优先，忽略大小写与首尾空格）、英文机场名、英文城市名、内置中文名 / 城市 / 别名。

添加航段时会把所选机场的**快照**存入该假期，因此以后更新机场目录不会改变或丢失旧行程中的机场。

## 4. 数据保存、备份与恢复

- 数据保存在当前浏览器的 IndexedDB（数据库 `holiday-flight-map`）。**清理浏览器站点数据、使用隐私模式或更换浏览器 / 设备都会导致记录不可见或被删除**。请定期导出备份。
- 导出：顶栏「备份」→「导出备份（JSON）」。文件包含 `schemaVersion: 1`、全部假期、航段，以及每个被引用机场的快照。
- 导入：「备份」→「导入备份…」。
  - 先校验：文件大小（≤ 5 MB）、JSON 结构、版本（不支持的未来版本直接拒绝）、唯一 ID、日期、坐标范围、字段长度、关联引用（航段 → 假期 / 机场）。任何错误都不会改动现有数据。
  - 只支持「作为新假期追加」：所有对象生成新 ID 并重建关联，不覆盖现有数据。
  - 确认前显示待导入的假期 / 航段数量；与现有假期内容相同时提示可能重复，由用户决定是否继续。
  - 确认后在单个事务中写入，失败则整体回滚。

## 5. 航线动画 GIF

顶栏「导出动画」生成循环播放的 GIF：飞机按航段顺序依次飞过整段行程，左上角显示当前航段（编号、IATA、日期），底部保留「示意航线」说明与底图署名。

- 尺寸：640×400（默认，较小文件）或 960×600。
- 时长：12 fps；每段 1.2–3 秒（总动画约 18 秒以内，航段越多每段越短）；起始停留 0.7 秒，终点停留 2.5 秒。这是演示时长，与实际飞行时长无关。
- 实现（`src/features/export/gifExport.ts`）：
  1. 用独立的离屏地图渲染一次底图（所有航线淡色），不影响主地图视角和回放进度；
  2. 每帧在 2D 画布上叠加已飞航段、当前航段轨迹和飞机，位置按地理距离参数化（与应用内回放一致），跨 ±180° 经线的航线会平移到画面所在的世界副本；
  3. 全局调色板（航线、飞机、文字颜色保留精确槽位）+ 帧差透明压缩，由 [gifenc](https://github.com/mattdesl/gifenc) 编码。示例行程 640×400 约 260 KB。
- 生成过程中显示进度，可随时取消；底图加载失败时不保存文件，可改为导出标注「无底图」的动画。
- 纯函数（帧计划、屏幕坐标插值、帧差）见 `src/features/export/gifPlan.ts`，有单元测试。
- 性能：有 GPU 加速的浏览器每帧约 10 ms，整段导出约 2–3 秒；在软件渲染 WebGL（如 SwiftShader、禁用硬件加速）下每帧画布读回约 0.3 秒，导出会明显变慢。

## 6. 支持的浏览器与验证记录

需要支持 **WebGL2** 的现代浏览器（MapLibre GL JS v6 仅支持 WebGL2）：近期版本的 Chrome / Edge / Firefox / Safari（桌面与移动端）。WebGL2 不可用时，地图区域显示说明，行程管理、统计与 JSON 备份仍可使用，海报导出按钮禁用。

本版本实际执行的验证（2026-10-08，macOS，Node 22.22.1，Google Chrome 通过 Playwright 1.64，SwiftShader WebGL）：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | 命令行 | 通过 |
| `npm run lint` | oxlint | 0 error（余 7 条 React 规则 warning，见「当前限制」） |
| `npm test` | Vitest，57 项 | 通过 |
| `npm run test:e2e` | Playwright，7 项；**底图瓦片被拦截为本地固定图片** | 通过：创建/编辑/重排/删除并刷新恢复；示例加载不重复；播放/暂停/恢复/变速/拖动/重播；备份导出与追加导入、非法文件拒绝；PNG 海报尺寸 1600×1000 且地图区域非空、导出不改变主视图与播放进度；NRT→LAX 动画 GIF 可取消、可被浏览器解码（37 帧，首尾帧内容不同）；390px 手机布局无水平溢出 |
| 真实 OSM 底图 | 手动脚本（Playwright 驱动 Chrome，未拦截瓦片），dev 与 `vite preview` 生产构建 | 主地图正常显示 OSM 瓦片；示例行程与 NRT→LAX→AKL→SYD 海报导出成功，海报含底图、航线、机场标签、中文标题、统计与 OSM 署名；NRT→LAX 航线经北太平洋，无横贯全球的连线 |
| 动画 GIF（真实底图） | 手动脚本（Chrome，GPU 渲染），dev 与生产构建 | 示例行程 640×400 / 960×600 及 NRT→LAX→AKL→SYD 导出成功（约 2–3 秒，145 / 109 帧，260–440 KB）；逐帧检查：航段按顺序播放、飞机朝向正确、跨经线航线连续、航线颜色准确 |
| 故障场景 | 手动脚本 | 瓦片全部失败：地图显示「底图加载失败」+ 重试，海报导出提示失败并可选择「无底图」海报；WebGL 不可用：显示说明，列表可用；IndexedDB 不可用：显示存储错误与重试 |

未验证：Safari / Firefox 实机、真实移动设备触控、其他瓦片供应商 / `VITE_MAP_STYLE_URL` 配置。

## 7. 当前限制

- 航线为根据机场坐标计算的大圆示意航线，**不代表实际飞行轨迹**；距离为球面大圆距离估算（平均地球半径 6371.0088 km）。
- 只记录出发地当地日期，不记录起降时间，不计算飞行时长、碳排放等。
- 回放时间为演示时间（每段约 6 秒），与实际飞行时长无关。
- 无云同步、无账号、无分享；数据只在当前浏览器。
- **不支持多标签页并发编辑**：在多个标签页同时修改可能导致界面显示旧数据，请只在一个标签页中编辑（刷新即可看到最新数据）。
- 视野只在创建 / 切换假期、首个航段加入或点击「重置到完整行程」时自动适配；后续添加航段不会抢占当前视角。
- 二维平面地图；地球视图未实现。
- 底图需要联网；地图不提供离线模式。
- lint 中保留的 warning 为 React 规则对「effect 中同步重置状态」（对话框打开时重置表单、数据加载、回放重置）以及 context hook 与 Provider 同文件导出的提示，不影响运行。

## 后端（开发中）

`server/` 是正在开发的后端服务（Go + Butterfly + ConnectRPC，PostgreSQL + Redis，部署在 k8s），用于账号与云同步。
目前已支持 GitHub / Google 登录（顶栏账号入口），行程云同步尚在开发；未设置 `VITE_API_BASE_URL` 时不显示账号入口，应用保持纯本地模式。
设计见 [docs/backend-phase1-design.md](docs/backend-phase1-design.md)，开发说明见 [server/README.md](server/README.md)。

## 目录结构

```text
src/
  app/                  App 布局、全局数据上下文（AppDataContext）
  components/ui/        shadcn/ui 组件
  features/trips/       假期表单、选择器、空状态、示例行程
  features/flights/     航段列表、航段表单、机场搜索选择器
  features/map/         MapLibre 地图、地图配置、航线图层、航段信息卡
  features/playback/    回放状态 hook 与控制条
  features/stats/       统计栏
  features/export/      PNG 海报、动画 GIF、JSON 备份菜单与导入
  data/                 airports.json、airport-aliases.json
  lib/db.ts             Dexie 数据库定义
  lib/repositories/     TripRepository（集中管理读取与事务）
  lib/geo/              大圆插值、跨经线处理、视野范围、统计
  lib/playback/         回放进度纯函数
  lib/backup/           备份构建、校验、导入计划
  types/                核心类型
  gen/                  buf 生成的 TypeScript（proto 客户端类型）
  lib/api/              后端 API 客户端（ConnectRPC）
proto/                  后端 API 定义（protobuf）
server/                 后端服务（Go），见 server/README.md
docs/                   设计文档
scripts/build-airports.ts
tests/unit/             Vitest
tests/e2e/              Playwright
tests/fixtures/         测试用机场（含 NRT、LAX、AKL 跨经线用例）
```
