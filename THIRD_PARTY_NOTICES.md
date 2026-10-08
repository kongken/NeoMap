# Third-Party Notices

## 机场数据：OurAirports

- 来源：<https://ourairports.com/data/>（镜像 <https://davidmegginson.github.io/ourairports-data/>，文件 `airports.csv`、`countries.csv`）
- 许可：Public Domain（公共领域）。虽无署名义务，本项目仍注明来源。
- 获取日期：2026-10-08（见 `src/data/airports.json` 的 `meta.fetchedAt`）
- 转换：`scripts/build-airports.ts` 生成 `src/data/airports.json`，规则见 README「机场数据」。
- 中文名称与别名：`src/data/airport-aliases.json` 由本项目人工整理，非 OurAirports 数据。

## 地图数据：OpenStreetMap

- 默认底图瓦片来自 OpenStreetMap 标准瓦片服务 <https://tile.openstreetmap.org>。
- 地图数据 © OpenStreetMap contributors，依据 Open Database License (ODbL) 提供：<https://www.openstreetmap.org/copyright>
- 瓦片使用须遵守 OSMF 瓦片使用政策：<https://operations.osmfoundation.org/policies/tiles/>。默认配置只适合本地低流量开发；公开部署前请更换为有授权的瓦片供应商，并核对其条款、额度和截图/导出权限。
- 应用内地图与导出的海报均保留「© OpenStreetMap contributors」及版权页链接；使用其他供应商时，其署名也会被保留。

## 开源软件

运行时主要依赖（完整列表见 `package.json` 和 `package-lock.json`）：

| 软件 | 许可 |
| --- | --- |
| MapLibre GL JS | BSD-3-Clause |
| React / React DOM | MIT |
| Dexie | Apache-2.0 |
| React Hook Form | MIT |
| Zod | MIT |
| Lucide React | ISC |
| Radix UI | MIT |
| shadcn/ui（组件源码复制于 `src/components/ui`） | MIT |
| cmdk | MIT |
| Sonner | MIT |
| Tailwind CSS / tw-animate-css / tailwind-merge / clsx | MIT |
| class-variance-authority | Apache-2.0 |
| Geist 字体（@fontsource-variable/geist） | SIL Open Font License 1.1 |
