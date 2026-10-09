# NeoMap 后端第一阶段设计：账号与云同步

状态：草案（2026-10-08）；里程碑 1（骨架）、2（认证）、3（行程 API）、4（前端同步）已完成

## 1. 目标与范围

**目标**：用户登录后，行程在多台设备之间同步；换浏览器、清理站点数据不再丢失数据。

**范围内**

- GitHub / Google OAuth 登录、退出、获取当前用户
- 行程（假期 + 航段 + 机场快照）的云端存储与双向同步
- 首次登录时把本地已有行程上传到账号
- 同步冲突的检测与处理
- 账号注销（删除全部数据）

**范围外（后续阶段）**：分享链接、海报 / GIF 上传、地图瓦片代理、机场数据定时更新、航班号查询、多人协作。

**不变的原则**

- 不登录也能完整使用；本地 IndexedDB 继续是前端的数据源，登录只是附加同步。
- JSON 备份 / 恢复照常可用，`BackupV1` 仍是导出格式。
- 前端界面层只依赖 `TripRepository`，同步逻辑放在新增的同步模块里。

## 2. 技术选型

沿用 [orvice/butter](https://github.com/orvice/butter) 的技术栈，只取骨架，不引入 Agent、工作区等无关模块。

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 语言 / 框架 | Go 1.27 + Butterfly（`butterfly.orx.me/core`） | 配置、日志、Gin HTTP、OTel、Prometheus |
| API | ConnectRPC + Protobuf，`buf` 生成 Go 与 TS | 前端用 `@connectrpc/connect-web` |
| 请求校验 | protovalidate（`buf.build/bufbuild/protovalidate`） | Butter 用的 `protoc-gen-validate` 已被官方 protovalidate 取代，新项目建议直接用后者 |
| 数据库 | PostgreSQL | Butterfly `store.db`，`driver: postgres`（pgx stdlib，`database/sql`） |
| 缓存 / 会话 | Redis（≥ 7.0） | Butterfly `store.redis`：登录会话、OAuth state、限流、定时任务租约 |
| 数据库迁移 | goose（SQL 文件嵌入二进制） | `neomap-api migrate up` 子命令，部署前以 k8s Job 运行 |
| 部署 | k8s：API 为 Deployment；前端继续在 Cloudflare Pages | 见第 8 节 |

**Butterfly SQL 配置的注意事项**（读源码确认）

- DSN 由 `postgres://user:password@host:port/db?sslmode=…` 直接拼接，密码**没有做 URL 转义**：密码避免使用 `@ : / ? #` 等字符，或在启动时自行构造连接。
- `ssl_mode` 默认 `disable`，生产必须显式设置（如 `require` / `verify-full`）。
- 只调用了 `sql.Open`，不会主动连接：服务启动时需要自己 `PingContext`，失败则退出，避免带病就绪。
- 连接池参数（`SetMaxOpenConns` 等）需要在应用里设置。

## 3. 总体架构

```text
浏览器（app.<domain>，Cloudflare Pages）
  React + IndexedDB（本地数据源）+ 同步模块
        │  HTTPS，Cookie 会话
        ▼
Ingress（api.<domain>，TLS）
        ▼
neomap-api（k8s Deployment，≥2 副本，无状态）
  ├─ HTTP：/ping、/healthz、/auth/oauth/{provider}/start|callback
  └─ ConnectRPC：/neomap.v1.AuthService/*、/neomap.v1.TripService/*
        │                    │
        ▼                    ▼
   PostgreSQL               Redis
   用户、身份、行程        会话、OAuth state、限流
```

**为什么前端与 API 必须在同一主域下**：会话用 HttpOnly Cookie（`Domain=.<domain>`，`SameSite=Lax`）。如果前端留在 `*.pages.dev`，与 API 跨站，Cookie 需要 `SameSite=None`，并会受到浏览器第三方 Cookie 限制。因此 Pages 需要绑定自定义域名 `app.<domain>`，API 使用 `api.<domain>`。

## 4. 认证

### 4.1 OAuth 流程（服务端完成，不经过前端 JS）

1. 前端跳转 `GET https://api.<domain>/auth/oauth/github/start?return_to=/`。
2. API 生成随机 `state` 与 PKCE `code_verifier`，存 Redis：`neomap:oauth:state:<state>`，TTL 10 分钟，内容含 provider、verifier、`return_to`。302 到 GitHub。
3. GitHub 回调 `/auth/oauth/github/callback?code&state`：取出并**删除** state（一次性），校验 state 属于同一登录方式，换取 token，读取用户信息（GitHub 需额外取已验证邮箱）。
4. 按 `(provider, provider_user_id)` 查找或创建用户（表结构见第 5 节）。
5. 签发会话，`Set-Cookie: neomap_session=…; Domain=.<domain>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`，302 回 `https://app.<domain>{return_to}`。
6. `return_to` 只允许站内相对路径，防止开放重定向。

OAuth provider 代码参照 Butter 的 `internal/auth/provider`（GitHub、Google），与 Butter 不同的是回调由服务端处理并直接写 Cookie。

### 4.2 会话

- 令牌：32 字节随机数，base64url 编码后放进 Cookie。Redis 只存 SHA-256 摘要：`neomap:session:<sha256>` → `{user_id, created_at, user_agent}`。
- 有效期 30 天，滑动续期：剩余不足 15 天时访问即续期。
- 用户维度索引：`neomap:user-sessions:<user_id>`（Set），用于「退出所有设备」和注销账号。
- Redis 丢数据的后果只是用户需要重新登录，可以接受；但仍建议开启 AOF。

### 4.3 CSRF 与跨域

- CORS：只允许 `https://app.<domain>`（开发环境加 `http://localhost:5173`），`Access-Control-Allow-Credentials: true`。
- 所有写操作都是 ConnectRPC POST，要求请求带 `Connect-Protocol-Version` 头，并校验 `Origin` 在白名单内。`SameSite=Lax` 加自定义请求头，足以阻止跨站表单伪造。

## 5. 数据模型（PostgreSQL）

同步的基本单位是**整个行程**（假期 + 航段 + 机场快照），与前端现有的 `TripBundle` 一致。行程数据量很小，整体读写比逐条航段同步简单得多，也不会出现「航段属于已删除假期」之类的中间状态。

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  display_name  text NOT NULL,
  email         text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  provider          text NOT NULL,            -- 'github' | 'google'
  provider_user_id  text NOT NULL,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX ON user_identities (user_id);

-- 全局递增的变更序号，用作增量同步游标
CREATE SEQUENCE trip_change_seq;

CREATE TABLE trips (
  id          uuid PRIMARY KEY,               -- 沿用前端生成的 UUID
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  start_date  date,
  end_date    date,
  notes       text CHECK (char_length(notes) <= 1000),
  is_sample   boolean NOT NULL DEFAULT false,
  revision    bigint NOT NULL DEFAULT 1,      -- 乐观锁，每次写入 +1
  change_seq  bigint NOT NULL DEFAULT nextval('trip_change_seq'),
  created_at  timestamptz NOT NULL,           -- 客户端创建时间
  updated_at  timestamptz NOT NULL,           -- 客户端最后修改时间
  server_updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,                    -- 软删除（墓碑）
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX ON trips (user_id, change_seq);

-- 机场快照（与前端 ReferencedAirport 对应）
CREATE TABLE trip_airports (
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  airport_id    text NOT NULL,                -- 'oa:26674' 或 'snap:<uuid>'
  iata          char(3) NOT NULL,
  name          text NOT NULL,
  name_zh       text,
  city          text,
  city_zh       text,
  aliases       text[],
  country_code  text NOT NULL,
  country_name  text,
  latitude      double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  PRIMARY KEY (trip_id, airport_id)
);

CREATE TABLE flight_legs (
  id                    uuid PRIMARY KEY,
  trip_id               uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ord                   integer NOT NULL CHECK (ord >= 0),
  departure_airport_id  text NOT NULL,
  arrival_airport_id    text NOT NULL,
  departure_date        date NOT NULL,
  flight_number         text CHECK (char_length(flight_number) <= 12),
  airline               text CHECK (char_length(airline) <= 60),
  notes                 text CHECK (char_length(notes) <= 1000),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (trip_id, ord) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (trip_id, departure_airport_id) REFERENCES trip_airports(trip_id, airport_id),
  FOREIGN KEY (trip_id, arrival_airport_id)   REFERENCES trip_airports(trip_id, airport_id)
);
```

**约束与上限**（服务端强制，与前端 Zod 一致）：每用户最多 500 个假期，每个假期最多 200 段，单次请求体 ≤ 1 MB。

**墓碑清理**：`deleted_at` 超过 90 天的行程由定时任务物理删除（用 Redis 租约保证只有一个副本执行）。清理时把该用户被删墓碑的最大 `change_seq` 记入 `users.tombstones_purged_through`（迁移 00002）；游标落在 `(0, 该水位)` 之间时 `ListChanges` 返回 `FailedPrecondition`，客户端清空游标全量拉取（见 6.4）。清理逻辑已实现（`trip.Postgres.PurgeTombstones`），定时调度在里程碑 5 接入。

## 6. 同步协议

### 6.1 API（`proto/neomap/v1/`）

```proto
service AuthService {
  rpc GetMe(GetMeRequest) returns (GetMeResponse);                 // 未登录时返回空 user（页面每次加载都调用，未登录不是错误）
  rpc ListProviders(ListProvidersRequest) returns (ListProvidersResponse);
  rpc Logout(LogoutRequest) returns (LogoutResponse);             // all_devices 可选
  rpc DeleteAccount(DeleteAccountRequest) returns (DeleteAccountResponse); // 里程碑 5
}

service TripService {
  // 增量拉取：返回 change_seq > cursor 的行程（含墓碑），按 change_seq 升序分页
  rpc ListChanges(ListChangesRequest) returns (ListChangesResponse);
  // 写入整个行程；base_revision = 0 表示新建
  rpc PutTrip(PutTripRequest) returns (PutTripResponse);
  rpc DeleteTrip(DeleteTripRequest) returns (DeleteTripResponse);
}

message TripBundle {
  Trip trip = 1;                    // 含 id、title、日期、notes、is_sample、created_at、updated_at
  repeated FlightLeg legs = 2;      // ord 连续，从 0 开始
  repeated Airport airports = 3;    // 每个被引用机场一份快照
  int64 revision = 4;               // 服务端返回
  bool deleted = 5;                 // 墓碑
}

message ListChangesRequest  { string cursor = 1; int32 page_size = 2; }   // cursor 为空表示全量
message ListChangesResponse { repeated TripBundle trips = 1; string next_cursor = 2; bool has_more = 3; }
message PutTripRequest      { TripBundle bundle = 1; int64 base_revision = 2; }
message PutTripResponse     { TripBundle bundle = 1; }               // 携带新 revision
message DeleteTripRequest   { string trip_id = 1; int64 base_revision = 2; }
```

字段级校验用 protovalidate 注解表达（UUID 格式、日期格式、长度、坐标范围、IATA 三位大写字母）；跨字段规则（航段引用的机场必须在快照内、同一航段起终点 IATA 不同、`ord` 连续）在服务层校验。

### 6.2 写入（PutTrip）

单个事务内：

0. `SELECT 1 FROM users WHERE id = $user FOR UPDATE`：**同一用户的写入串行化**。`change_seq` 在事务中途取号、提交顺序可能与取号顺序不同；如果不串行化，两个并发写入可能乱序提交，客户端游标越过较小的号后会永久漏掉那条变更。按用户加锁后，同一用户的 `change_seq` 提交顺序与取号顺序一致，而游标本来就是按用户读取的。
1. `SELECT … FROM trips WHERE id = $1 FOR UPDATE`。
2. 不存在：`base_revision` 必须为 0，插入（`revision = 1`）。若该 id 已属于其他用户，返回 `AlreadyExists`，客户端为该行程重新生成 ID 后重试。
3. 存在且属于当前用户：`revision` 必须等于 `base_revision`，否则返回 `Aborted`，并附带服务端当前版本（`ErrorDetail` 中携带 `TripBundle`）。
4. 删除该行程原有的 `flight_legs`、`trip_airports`，再插入新数据；`revision += 1`，`change_seq = nextval(...)`，`server_updated_at = now()`，`deleted_at = NULL`。

**实现补充**（里程碑 3）：

- **幂等重试**：`base_revision` 不一致但提交内容与服务端当前内容完全相同时，视为「成功写入后响应丢失的重试」，直接返回当前版本，不报冲突（避免客户端误建副本）。
- **恢复墓碑**：以墓碑的版本号为 `base_revision` 写入即可恢复；用旧版本修改已删除的行程返回 `Aborted`（详情中 `deleted = true`）。
- **ID 被占用**：行程 ID 属于其他用户、或航段 ID 被其他行程使用时返回 `AlreadyExists`，客户端换新 ID 重试。删除他人行程返回 `NotFound`（不泄露其存在）。
- **数量上限**：新建或恢复行程超过 500 个时返回 `ResourceExhausted`。
- **游标**：格式 `c1.<change_seq>`，客户端视为不透明字符串；没有新变更时 `next_cursor` 原样返回。
- **请求校验**：字段级规则写在 proto（protovalidate，由 Connect 拦截器执行），跨字段规则（日期真实存在、结束不早于开始、航段顺序从 0 连续、航段引用的机场存在于快照、起终点 IATA 不同、ID 不重复）在服务层校验；请求体上限 1 MiB。

`DeleteTrip` 同样先锁用户行、检查 `base_revision`，然后设置 `deleted_at`、`revision += 1`、`change_seq = nextval(...)`，并删除航段与快照；墓碑同时清除标题、日期、备注（不保留用户内容），对外只暴露行程 ID。已删除的行程重复删除是幂等的。

### 6.3 客户端同步模块

本地 IndexedDB（Dexie 数据库版本 2）新增三张表，领域数据（`trips` / `legs` / `referencedAirports`）与备份格式不变：

- `tripSync`：每个行程的 `state`（`dirty` / `synced` / `error`）、`serverRevision`、`localOnly`（「仅本设备」）、`localVersion`（本地修改计数）、`error`。
- `pendingDeletes`：已在本地删除、尚未通知服务端的行程及其 `serverRevision`。
- `syncMeta`：关联的账号（`userId`、`displayName`）、`cursor`、`lastSyncedAt`。

升级时，已有行程全部标记为 `dirty`、`serverRevision = 0`（尚未关联账号），首次登录时由用户决定是否上传。

`TripRepository` 的每次写入在同一事务内把行程标记为 `dirty` 并递增 `localVersion`；删除已上传的行程时写入 `pendingDeletes`。同步引擎（`SyncEngine`）通过 `SyncStore` 写入服务端结果，不会再次标记为待同步。

**上传期间的本地修改**：上传时连同 `localVersion` 一起读取快照；上传成功后只有 `localVersion` 未变才标记为 `synced`，否则保持 `dirty`、下次以新版本继续上传。上传期间被删除的行程，其 `pendingDeletes` 记录更新为上传后的版本，避免删除被误判为冲突。

**自己写入的回声**：拉取到 `revision ≤ serverRevision` 的行程（本设备刚上传的）直接跳过。

同步时机：登录后、页面回到前台、恢复网络（`online` 事件）、本地写入后防抖 2 秒、每 5 分钟；同一时间只运行一次，运行中再次触发会在结束后补跑。一次同步：

1. **推送**：对每个 `dirty` 行程调用 `PutTrip(bundle, serverRevision ?? 0)`；已删除的调用 `DeleteTrip`。成功后更新 `serverRevision`，标记 `synced`。
2. **拉取**：`ListChanges(cursor)` 直到 `has_more = false`。对每个返回的行程：
   - 本地不存在或为 `synced`：直接覆盖（墓碑则删除本地）。
   - 本地为 `dirty`：说明两端都改了，进入冲突处理。
3. 保存新的 `cursor`。

同步模块只通过 `TripRepository` 的事务方法读写本地数据；界面层只多出「同步状态」显示。

### 6.4 冲突处理

不做字段级合并。冲突时**以服务端为准**，同时不丢失本地修改（内容完全相同时不算冲突，不产生副本）：

- 本地版本另存为一个新行程（新 ID，标题加「（本设备副本）」），标记 `dirty`，下一轮上传。
- 服务端版本覆盖原行程。
- 界面提示：「『亚洲假期』在其他设备上被修改，本设备的修改已另存为副本」。

其他组合：

- 本地删除、其他设备之后又修改：删除不生效，保留服务端版本（提示「本设备的删除未生效」）。
- 本地修改、其他设备已删除：本地内容另存为新行程（冲突副本），原行程删除。
- `AlreadyExists`：行程与航段换新 ID 重新上传，界面保持选中换 ID 后的行程。
- `NotFound`（服务端已无该行程）：改为新建（`base_revision = 0`）。
- `InvalidArgument` / `ResourceExhausted`：该行程标记为 `error` 并显示原因，不阻塞其他行程；用户再次修改后重试。
- `Unauthenticated`：停止同步，提示重新登录；网络错误：显示离线，恢复网络后自动重试。

`ListChanges` 返回 `FailedPrecondition`（游标对应的墓碑已被清理）时，客户端丢弃游标并全量拉取；本地 `synced` 但服务端已不存在的行程直接删除，`dirty` 的重新上传。

### 6.5 首次登录与退出

- **首次登录**：本地有未上传的行程时询问「同步本设备上的假期？」：选择「上传到账号」则逐个 `PutTrip(base_revision = 0)` 后完整拉取；选择「仅保留在本设备」则这些行程标记为 `localOnly`，只拉取云端数据。`localOnly` 的行程在假期详情中显示「仅本设备」并可单独「上传到账号」。本地没有行程时直接关联、不弹窗。
- **换账号登录**：本地数据关联的账号与新账号不同时，提供「清除后继续」「保留为本地数据」（随后询问是否上传到新账号）「取消并退出登录」，有未同步修改时提示，不自动合并。
- **退出登录**：说明本设备上属于该账号的假期数量，有未同步修改时警告；默认「从本设备清除这些假期」（共用设备的隐私），可选「保留在本设备」作为未登录的本地数据（重新登录时询问是否上传）。「仅本设备」的行程始终保留。
- **会话失效**：本地修改照常保存并标记为待同步，账号菜单提示「登录后继续同步」。

## 7. 安全与隐私

- 行程属于敏感个人信息（日期 + 地点可推断不在家的时间）：只存必要字段；日志不记录行程内容。
- 所有查询都带 `user_id` 条件，仓储接口第一个参数就是 `userID`（参考 Butter 的 `workspaceID` 约定），防止越权访问。
- 限流（Redis 计数器）：每用户写入 60 次 / 分钟，每 IP 登录发起 20 次 / 分钟。
- `DeleteAccount`：同一事务删除用户及其全部数据（级联），并清除该用户所有 Redis 会话。
- 上线前需要隐私政策页面；数据导出复用现有 JSON 备份。

## 8. 部署（k8s）

| 资源 | 说明 |
| --- | --- |
| `Deployment/neomap-api` | 2 个副本，distroless 镜像（参照 Butter 的 Dockerfile）；readiness `/healthz`（检查 Postgres、Redis），liveness `/ping`；资源请求约 50m CPU / 64Mi |
| `Service` + `Ingress` | `api.<domain>`，cert-manager 签发 TLS |
| `ConfigMap` | Butterfly `config.yaml`（`store.db.main`、`store.redis.main`、CORS 白名单、Cookie 域名、OAuth 回调地址） |
| `Secret` | 数据库密码、Redis 密码、OAuth client secret |
| `Job/neomap-migrate` | 每次发布前运行 `neomap-api migrate up`（Helm pre-upgrade hook 或 Argo CD PreSync） |
| `PodDisruptionBudget` | `minAvailable: 1` |
| PostgreSQL | 托管实例或集群内 CloudNativePG；需要每日备份 + PITR |
| Redis | 集群内单实例即可（开启 AOF），会话丢失只影响登录状态 |

CI：参照 Butter 的 `go.yml`（`go test`）、`buf.yml`（lint + breaking）、`docker-publish.yml`（推送 ghcr）。

## 9. 仓库结构

```text
NeoMap/
├── (前端保持在根目录，部署到 Cloudflare Pages)
├── src/gen/neomap/v1/          # buf 生成的 TS 代码
├── src/features/sync/          # 同步模块、登录 UI、同步状态
├── proto/neomap/v1/            # auth.proto、trip.proto
├── buf.yaml / buf.gen.yaml
└── server/                     # 独立 go.mod
    ├── cmd/neomap-api/         # main（serve、migrate 子命令）
    ├── migrations/             # goose SQL，embed 进二进制
    └── internal/
        ├── app/                # 路由、装配
        ├── application/        # AuthService、TripService 实现
        ├── auth/               # OAuth provider、会话、中间件
        ├── repo/{user,trip}/{postgres,memory}
        └── ratelimit/
```

## 10. 测试

- Go：仓储层用 testcontainers 启动真实 Postgres / Redis；服务层用 memory 仓储做单元测试，重点覆盖乐观锁、越权访问、校验与墓碑。
- 前端：同步模块用假的 TripService 客户端做单元测试（推送、拉取、冲突另存副本、游标失效）。
- E2E：docker compose 启动 API + Postgres + Redis，Playwright 用测试专用登录入口（仅测试环境开启）覆盖：登录 → 上传本地行程 → 第二个浏览器上下文看到同步结果 → 双端同时修改产生冲突副本。

## 11. 里程碑

1. ✅ 骨架：Butterfly + ConnectRPC + 迁移 + `/healthz`，CI 与镜像发布。
2. ✅ 认证：OAuth（GitHub、Google，带 PKCE）、会话、`GetMe` / `ListProviders` / `Logout`，前端登录入口。
3. ✅ 行程 API：`PutTrip` / `DeleteTrip` / `ListChanges`，仓储与测试（墓碑清理的定时调度放到里程碑 5）。
4. ✅ 前端同步模块：推送、拉取、冲突处理、首次登录上传、同步状态 UI（`src/lib/sync/`、`src/features/sync/`）。
5. 上线准备：k8s 清单、限流、账号注销、隐私政策。

## 12. 待决定

1. 域名：`app.<domain>` / `api.<domain>` 用哪个主域？Pages 需要绑定该自定义域名。
2. PostgreSQL：托管服务还是集群内 CloudNativePG？
3. Go module 路径：沿用 Butter 的风格 `go.orx.me/apps/neomap`，还是 `github.com/kongken/neomap/server`？
4. ~~第一版提供哪些登录方式~~：已定为 GitHub + Google。
5. k8s 发布方式：Helm、Kustomize 还是 Argo CD？
