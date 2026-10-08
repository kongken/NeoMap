# neomap-api

NeoMap 的后端服务：Go + [Butterfly](https://butterfly.orx.me) + ConnectRPC，存储使用 PostgreSQL 与 Redis。
第一阶段（账号与云同步）的整体设计见 [docs/backend-phase1-design.md](../docs/backend-phase1-design.md)。

已完成：骨架（健康检查、迁移、`SystemService`）与**登录**（GitHub / Google OAuth、Redis 会话、`AuthService`）。行程同步接口尚未实现。

## 本地开发

需要 Go 1.27+、Docker（或 OrbStack）、[buf](https://buf.build/docs/installation)。

```bash
cd server
docker compose up -d --wait          # Postgres :5433、Redis :6380

export BUTTERFLY_CONFIG_TYPE=file
export BUTTERFLY_CONFIG_FILE_PATH=config/config.dev.yaml
go run ./cmd/neomap-api              # 监听 :8080（可用 PORT 覆盖）；开发配置会自动执行迁移
```

验证：

```bash
curl localhost:8080/ping       # 存活检查，不检查依赖
curl localhost:8080/healthz    # 就绪检查：Postgres + Redis，不可用时返回 503
curl -X POST -H 'Content-Type: application/json' -d '{}' \
  localhost:8080/neomap.v1.SystemService/GetServerInfo
```

前端接入：在根目录 `.env.local` 中设置 `VITE_API_BASE_URL=http://localhost:8080` 后运行 `npm run dev`。
不设置时前端保持纯本地模式，不发起任何后端请求。

## 登录（OAuth）

| 路径 | 说明 |
| --- | --- |
| `GET /auth/oauth/{github,google}/start?return_to=/path` | 跳转到登录方式的授权页 |
| `GET /auth/oauth/{github,google}/callback` | 授权回调：签发会话 Cookie，跳回 `{app_base_url}{return_to}?login=success`，失败时为 `?login_error=<原因>` |
| `AuthService.GetMe` | 当前用户；未登录时返回空 user（不是错误） |
| `AuthService.ListProviders` | 已启用的登录方式 |
| `AuthService.Logout` | 退出当前设备，`all_devices=true` 退出所有设备 |

实现要点：

- 授权码模式 + **PKCE（S256）**；`state` 存 Redis，10 分钟有效，`GETDEL` 保证只能用一次，并校验与回调的登录方式一致。
- 会话令牌只放在 HttpOnly、`SameSite=Lax` 的 Cookie 中；Redis 只存令牌的 SHA-256 摘要。默认 30 天，剩余不足一半时访问即续期。
- 邮箱只保存登录方式确认**已验证**的（GitHub 取 `/user/emails` 中已验证的主邮箱，Google 要求 `email_verified`）。
- 不同登录方式**不按邮箱自动合并**为同一账号，避免借助未验证邮箱接管账号；账号绑定留到以后实现。
- `return_to` 只接受站内相对路径（防开放重定向）。
- CSRF：写请求带 `Origin` 时必须在 `cors_allowed_origins` 白名单内；配合 `SameSite=Lax`。
- 登录发起按客户端 IP 限流（默认 20 次 / 分钟，Redis 计数，多副本共享）。客户端 IP 只采信 `http.trusted_proxies` 中代理传来的 `X-Forwarded-For`。
- **需要 Redis ≥ 7.0**（使用 `GETDEL`、`EXPIRE … NX`）。

### 创建 OAuth 应用

- **GitHub**：Settings → Developer settings → OAuth Apps → New OAuth App
  - Homepage URL：`https://app.<domain>`
  - Authorization callback URL：`https://api.<domain>/auth/oauth/github/callback`
- **Google**：Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID（Web application）
  - Authorized redirect URI：`https://api.<domain>/auth/oauth/google/callback`
  - OAuth consent screen 需配置应用名称与授权域名，scope 为 `openid email profile`

把 client ID / secret 写入配置的 `neomap.auth.providers`。本地开发：复制 `config/config.dev.yaml` 为 `config/config.local.yaml`（已被 git 忽略）填入凭据，回调地址用 `http://localhost:8080/auth/oauth/<provider>/callback`。未填写凭据的登录方式不会启用。

生产环境的 `app.` 与 `api.` 必须在同一主域下，并设置 `auth.cookie.domain: .<domain>`（见设计文档第 3 节）。

## 命令

```bash
neomap-api                  # 启动服务
neomap-api migrate up       # 执行迁移（生产：发布前以 k8s Job 运行）
neomap-api migrate down     # 回滚最近一次迁移
neomap-api migrate status   # 查看迁移状态
```

迁移文件在 `migrations/`（goose 格式，嵌入二进制），使用 Postgres advisory lock，多个副本同时执行也安全。

## 测试

```bash
go test ./...                                   # 单元测试
NEOMAP_TEST_POSTGRES_DSN='postgres://neomap:neomap@localhost:5433/neomap?sslmode=disable' \
  go test -race ./...                           # 含 PostgreSQL 集成测试（每个测试建临时数据库）
```

## Proto 与代码生成

proto 在仓库根目录 `proto/`，在根目录执行 `buf generate`：Go 代码输出到 `server/gen`，TypeScript 输出到 `src/gen`，生成结果纳入版本管理（CI 会检查是否最新）。

## 配置

配置是一份 YAML（示例见 `config/config.example.yaml`），通过 `BUTTERFLY_CONFIG_FILE_PATH` 指定：

- `store.db.<name>` / `store.redis.<name>`：Butterfly 管理的连接；
- `neomap.*`：应用配置（CORS 白名单、使用哪个连接、是否自动迁移、连接池参数）。

Butterfly 当前版本需要注意：

- 数据库密码不做 URL 转义，避免使用 `@ : / ? #` 等字符（`migrate` 子命令自行构造连接串，不受影响）；
- `ssl_mode` 默认 `disable`，生产环境必须显式设置；
- 配置文件不展开 `${ENV}`，生产环境把整份配置作为 k8s Secret 挂载；
- HTTP 服务器由 Butterfly 的 `gin.Run()` 启动，**没有优雅停机**：滚动发布时进行中的请求可能被中断。后续需要在 Butterfly 中支持，或配合 `preStop` 延迟与 readiness 摘流量缓解；
- Prometheus 指标固定监听 `:2223/metrics`。

## 部署（k8s）

镜像：`ghcr.io/<owner>/neomap-api`（`.github/workflows/server.yml` 在 main 分支和版本标签上发布）。

| 项 | 值 |
| --- | --- |
| 端口 | 8080（HTTP / ConnectRPC），2223（metrics） |
| readiness | `GET /healthz` |
| liveness | `GET /ping` |
| 环境变量 | 镜像已设置 `BUTTERFLY_CONFIG_TYPE=file`、`BUTTERFLY_CONFIG_FILE_PATH=/etc/neomap/config.yaml`、`PORT=8080`、`GIN_MODE=release` |
| 配置 | 以 Secret 挂载到 `/etc/neomap/config.yaml` |
| 迁移 | 发布前运行同一镜像的 `neomap-api migrate up`（Job） |

k8s 清单（Helm / Kustomize / Argo CD）待确定发布方式后补充。
