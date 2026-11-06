# AGENTS.md

分布式设备农场：`adh-server` 管设备，`adh-agent` 跑在设备宿主机上主动外连，Web 控制台实时预览与操作 Android 设备。

## 结构

pnpm workspace，6 个包：

| 路径                     | 职责                                                      |
| ------------------------ | --------------------------------------------------------- |
| `apps/server`          | Fastify + SQLite/MySQL + WebSocket，同时托管 web 构建产物 |
| `apps/agent`           | 宿主机守护进程：设备发现、缩略图上传、scrcpy 流           |
| `apps/web`             | Vue 3 + Naive UI（**不是 React**），shadcn 浅色风格 |
| `apps/portal-android`  | Android 设备内直连 App（Kotlin），不依赖宿主机            |
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
pnpm package:server --platform linux   # 打 server 包，会把 APK 一起塞进 portal/

# Android 设备直连 App（JDK 17 + Android SDK 34）
pnpm portal:build

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
- **Agent 自更新**：`adh-agent update` 只支持打包后的安装目录（有 `src/cli.js`），源码目录会直接拒绝。替换在独立 helper 进程里完成，先 rename 旧目录再放新目录，启动失败自动回滚；旧版本保留为 `<install>.bak-*`，`vendor/` 与 `~/.adh` 不参与替换。打包脚本产出 `dist/adh-agent-manifest.json`（含各平台 sha256），CI 必须和 zip 一起上传到 Release，否则 `update` 无法校验和识别新版本。
- **设备从 adb 消失时标记 offline，不删记录**；清理走 `DELETE /api/devices/:id`。
- **设备名优先取厂商市场名称**：`ro.vivo.market.name` → `ro.product.marketname` → OPPO / `ro.config.marketing_name` 等，取不到才回退到 `ro.product.model`。型号代码单独存在 `model` 字段。
- **AI 助手**：只有设备当前控制者能用，入口在设备控制页右侧常驻栏。模型配置存 `adh_settings` 的 `ai.*`，仅 superadmin 可改，apiKey 只留在服务端。执行是纯视觉闭环：截图 → 等待画面稳定 → VL 决策 → 动作 → 再截图 → 64×64 灰度指纹对比画面变化，不依赖 DOM / 无障碍树；复用 `StreamManager.sendControl` / `sendIosInput`，点击与滑动不另开 adb；纯 ASCII 文本（金额 / 密码 / 验证码）优先走 `input.text`（本机直连 adb，远程由 agent 执行），失败再回退 scrcpy 文本注入。对话记录存 `adh_ai_messages`，严格按 `device_id + user_id` 隔离，A 看不到 B 的对话；保留最近 100 条，支持单条删除与全部清空，删除时 SQL 同时限定 `user_id`。刷新后由 `GET /api/devices/:id/ai/messages` 恢复。远程设备的截图依赖 agent 的 `screenshot` action，旧版 agent 需要升级。模型必须是支持 vision 的 OpenAI 兼容接口。单任务最多 30 轮「截图 → 模型决策」（每轮可执行多个动作）、60 个实际动作；达到上限会落 `failed` 并提示拆分任务，不会当成成功。**查询 / 读取类任务**（「查看 / 看一下 / 查询 / 最近一条」等，见 `ai/query.ts`）走精简链路：不注入 `plan`、最多 8 轮 / 8 个动作，使用查询专用提示词；模型没给出回答时由 vision 模型再提取一次结构化结果（来源 / 时间 / 发送者 / 内容，见 `ai/extract.ts`），不是 OCR。截图全黑（息屏 / 锁屏）会先尝试 `KEYCODE_WAKEUP` 唤醒，仍全黑直接 `failed` 并提示手动解锁。
- **设备无线直连（Portal）**：`apps/portal-android` 是运行在 Android 设备内的设备侧 Agent，不依赖宿主机，Web 端入口叫「设备管理 → 设备无线直连」。复用 `/ws/agent` 与 `/ws/stream/:sessionId?role=agent`，使用平台全局配对 Key（`adh_settings` 的 `portal.key`，首次访问自动生成，全局只有一个）；每台设备按 `instanceId`（固定为 `ANDROID_ID`，不随 udid 变化）复用 / 创建自己的 `kind=portal` agent 行，welcome 下发本行 token 供流 / 缩略图 / 安装包下载使用。`devices.sync` 上报的设备 `capabilities` 含 `portal`。App 支持扫码连接（zxing，扫 Web 端第 3 步的二维码自动填地址）、MediaProjection H264 投屏（发送 **Annex-B**，viewer 侧再转 AVCC）、无障碍点击/滑动/全局按键、`input.text`（先 `ACTION_SET_TEXT`，失败再走自带输入法）、无障碍截图、`app.launch` / `app.install` / `app.uninstall`、相册导入、音量 / 锁屏 / 旋转。**不支持** `shell` / `logcat` / `reboot` / 任意路径文件。**保活**：前台服务 `dataSync|mediaProjection`、PARTIAL_WAKE_LOCK + WIFI_MODE_FULL_HIGH_PERF、JobScheduler 15 分钟 + AlarmManager 30 分钟、开机自启；从最近任务划掉**不停止**，只有 App 内点「断开」才真正停止（`Config.userStopped`）。**投屏授权**：只有 `ProjectionController.hasConsent` 为真才建立连接；`getMediaProjection()` 失败、系统停止共享、`release()` 都会清掉令牌并断开 WS，App 里按钮会变回「共享屏幕」引导重新授权。`ensureForeground(true)` 只能在真正要建流的那一刻调用（声明 mediaProjection 类型后迟迟不取投影会被系统杀进程）。首次使用需逐项授权：投屏、无障碍、默认输入法、所有文件、修改系统设置、通知、位置（WiFi 名称）、安装未知应用、忽略电池优化、自启动。构建：`pnpm portal:build`（JDK 17 + Android SDK 34），产物 `app/build/outputs/apk/debug/app-debug.apk`；`pnpm package:server` 会把它复制进包内 `portal/adh-portal.apk`，Web 端可直接下载。iOS 不支持设备内直连，需宿主机 Agent + WDA。
- **批量 AI 任务**：批量控制页右下角固定「AI 批量」悬浮按钮，只有一个 ChatGPT 风格对话框，不再让用户选模式。`POST /api/tasks/batch/plan` 把一句话和当前选中设备交给模型，由模型判断单台还是多台、相同任务还是按设备拆分，并返回 `tasks`（`POST /api/tasks/batch` 再落库执行）。`scope=single` 只控制一台，`batch+parallel` 多台同一任务（最多 3 并发，其余排队），`batch+sequential` 按设备顺序执行（适合 A 发消息、B 回复）。每台设备仍是独立 `adh_tasks` 记录，由 `TaskService.createBatch` 调度并复用视觉闭环。任务会复用当前用户自己的预览会话并加任务锁（不能抢其他用户控制的设备），执行过程画面继续可见，不再断流黑屏；排队任务可取消。批量页是独立标签页，点返回会先确认是否有 AI 任务在跑，确认后取消任务、断开所有设备并关闭标签页；直接关标签页也走同样的清理。设备墙默认 50% 缩放（范围 10%~200%，低于 30% 时隐藏标题栏只看画面），画面按设备比例完整显示，不裁切。
- **MCP / 外部 Agent**：server 内置 Streamable HTTP MCP，路径 `/mcp`，客户端只需配 `url`（`http://<ip>:8080/mcp?key=adhk_xxx`，也支持 `Authorization: Bearer`）。会话用 `Mcp-Session-Id`（stateful，按用户隔离，30 分钟空闲回收），路由在 `apps/server/src/http/mcp-routes.ts`。工具定义与两种 transport 共用 `apps/server/src/mcp/server.ts` / `backend.ts`：HTTP 模式直接调进程内 service，stdio 模式（`apps/server/src/mcp-cli.ts`，`ADH_SERVER_URL` + `ADH_API_KEY`）通过 REST 调平台，给只支持 stdio 的老客户端。工具为 `list_devices` / `get_device` / `run_task` / `batch_task` / `get_task` / `list_tasks` / `cancel_task` / `cancel_all_tasks`（共 8 个）。所有登录用户都可以在侧边栏「系统 → MCP 接入」使用自己的 Key；首次访问 `GET /api/api-keys` 会自动补一把 `default` Key 并在响应里返回明文，前端缓存在 localStorage（按用户隔离）。每个用户只有一把默认 Key，前端只提供 `POST /api/api-keys/reset` 重置，`POST /api/api-keys` 主动创建会返回 400。superadmin 能看和删除全部 Key，普通用户只能操作自己的。任务由 `TaskService` 调度：选在线、未锁、空闲设备 → 建投屏会话 → 跑 `runAiChat` → 落 `adh_tasks`；期间 `StreamManager.lockForTask` 阻止 viewer 抢占，结束自动释放。API Key 存 `adh_api_keys`，只在创建时返回一次明文。
- **`builtin-local` 是 server 内置 Agent**（进程内直连本机 adb），删除 / 重置 Key 接口返回 400，前端不展示这些按钮。
- **投屏会话与控制计时**：会话按设备复用（`findSessionByDevice`），复用前检查 `agentSocket` 是否还在，僵尸会话直接销毁重建；viewer 进来时若 `agentSocket` 为空会重发 `screen.start`。`controllerSince` 只在收到 agent 的 `ready`（首帧配置）后置位，**没出画面不算控制**，`getControl` / `isInUse` 都以它为准。控制者断开后 `controllerUser` 保留 30 秒（`CONTROLLER_RECONNECT_WINDOW_MS`），列表上继续显示「谁在控制」，超时才释放。`VIEWER_IDLE_TIMEOUT_MS` 为 30 分钟，退出控制页不会立即销毁会话。
- **画质切换**：直连设备走 `{t:'quality'}` 热切换（App 只重启 `ScreenEncoder` 并回发 `{t:'rotated'}` 新参数集），不断开会话；宿主 Agent（scrcpy）仍走 `restartStream` 重建会话。Web 端 `onQualityChange` 按 `isPortal` 分支。
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



