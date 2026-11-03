# AGENTS.md

分布式设备农场：`adh-server` 管设备，`adh-agent` 跑在设备宿主机上主动外连，Web 控制台实时预览与操作 Android 设备。

## 结构

pnpm workspace，5 个包：

| 路径                     | 职责                                                      |
| ------------------------ | --------------------------------------------------------- |
| `apps/server`          | Fastify + SQLite/MySQL + WebSocket，同时托管 web 构建产物 |
| `apps/agent`           | 宿主机守护进程：设备发现、缩略图上传、scrcpy 流           |
| `apps/web`             | Vue 3 + Naive UI（**不是 React**），shadcn 浅色风格 |
| `packages/protocol`    | 两端共享的 zod 消息 schema、二进制帧、H.264 工具          |
| `packages/device-host` | adb / scrcpy 采集能力，server 与 agent 共用               |

`packages/*` 的 `package.json` `exports` 直接指向 `src/*.ts`，**没有构建产物**，靠各 app tsconfig 的 `paths` + tsx 实时编译。

## 命令

```bash
pnpm dev                     # server:8080 + web:5173（vite proxy 到 8080）
pnpm -r typecheck            # 全量类型检查（web 用 vue-tsc）
pnpm build                   # 只产出前端到 apps/server/public
pnpm start                   # 单进程托管 API + 前端（需先 build）

# 接入一台设备宿主机（key 必须先由 Web 控制台创建）
pnpm --filter @adh/agent dev connect --server ws://<ip>:8080 --key adh_xxx
pnpm --filter @adh/agent dev doctor

# 打离线分发包（dist/agent + zip），目标机只需 Node 22+ 与 adb
pnpm package:agent

# 旧数据迁移：SQLite -> MySQL，本地文件 -> OSS
pnpm migrate:data
```

数据库连接和 OSS 都从 `.env` 读取（`MYSQL_*` / `ADH_OSS_*`）。
本地 `.data/` 只保留文件缓存：`packages/`、`thumbnails/`、`app-icons/`。

## 必须知道

- **改 `packages/*` 后要重启 server / agent**。`tsx watch` 只监听 app 自己的 `src`，共享包改动不会触发重载，容易出现"改了没生效"。
- **数据库支持两种后端**：默认 SQLite（`node:sqlite`，文件 `.data/adh.sqlite`），配置 `MYSQL_HOST` 后用 MySQL。查询在 `db/queries.ts` 用原生 SQL，方言差异集中在 `SqlDriver`（upsert / INSERT IGNORE / 迁移 DDL）。
- **数据库迁移手写 SQL**，放在 `apps/server/src/db/migrations/sqlite|mysql/NNNN_*.sql`，启动时按文件名排序各执行一次并记入 `adh_migrations`。不要修改已提交的迁移。
- **所有表名以 `adh_` 开头**（`adh_agents` / `adh_devices` / `adh_packages` / `adh_migrations`），新增表同样遵守。
- **文件存储可选 OSS**：配了 OSS 就同步到 `oss://<bucket>/adh/...`，本地 `.data/` 保留缓存；`ADH_STORAGE=local` 可强制只用本地。
- **Agent 有两个名字**：`name` 是用户可编辑的显示名，`hostName` 是 agent 上报的宿主机名。`updateAgentRuntime()` 故意不覆盖 `name`。
- **设备从 adb 消失时标记 offline，不删记录**；清理走 `DELETE /api/devices/:id`。
- **设备名优先取厂商市场名称**：`ro.vivo.market.name` → `ro.product.marketname` → OPPO / `ro.config.marketing_name` 等，取不到才回退到 `ro.product.model`。型号代码单独存在 `model` 字段。
- **`builtin-local` 是 server 内置 Agent**（进程内直连本机 adb），删除 / 重置 Key 接口返回 400，前端不展示这些按钮。
- 前端 `api.ts` 的 `request()` **只在有 body 时设置 `content-type`**。否则 DELETE 会被 Fastify 判为 400 `Body cannot be empty`。
- Web 端需要登录，角色 `admin`（含用户管理、审计）和 `operator`；默认管理员 `admin / admin`。Agent 仍用 `adh_` 前缀的 key 鉴权。

## scrcpy 投屏

- 协议是自己实现的，没有依赖桌面客户端。jar 在 `packages/device-host/resources/scrcpy-server.jar`（v2.4）。
- `tunnel_forward=true` 时**设备端按 video → control 顺序 accept**，必须建两个 socket，只建一个会导致控制失效。
- 视频流头部：**1 字节 dummy + 64 字节设备名 + 12 字节**（codec id / width / height）。dummy 字节只在 tunnel_forward 模式出现，漏掉它会导致宽高整体偏移。
- 视频数据不是裸 Annex-B，而是 `12 字节 packet 头 + payload`：8 字节 pts（最高位是 CONFIG 标记，次高位是 KEY_FRAME 标记）+ 4 字节长度。按 packet 切帧，不要直接扫起始码。
- `packages/protocol/src/h264.ts` 负责 SPS/PPS → avcC、Annex-B → AVCC 的转换。
- 浏览器用 WebCodecs 解码，`description` 走 base64 传输；控制坐标统一 **0..1 归一化**，由 `ScrcpyControlTranslator` 换算成设备像素。

## 关键文件

- 消息协议：`packages/protocol/src/messages.ts`
- 设备发现与硬件采集：`packages/device-host/src/android-discover.ts`
- 投屏会话管理：`apps/server/src/stream/manager.ts`、`apps/server/src/ws/stream.ts`
- Web 播放器：`apps/web/src/components/DevicePlayer.vue`
- 主题（shadcn 浅色）：`apps/web/src/theme.ts`，**不要再传 `darkTheme`**
