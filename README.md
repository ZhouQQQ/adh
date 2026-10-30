# ADH · 分布式设备农场

把散落在多台机器上的 Android / iOS 真机集中到一个 Web 控制台：实时查看屏幕、直接操作、批量安装应用。

- `adh-server`：Web 控制台 + 设备/节点管理，一个进程搞定
- `adh-server` 内置本机 Agent：**server 所在的机器本身就是一台设备宿主机**，插上设备即可被发现，无需额外启动进程
- `adh-agent`：部署在其它设备宿主机上，主动外连 server，自动发现并上报本机设备

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| M0 脚手架 · 节点接入 · 设备发现 · 实时看板 | ✅ 完成 |
| M1 Agent 管理 · 设备硬件信息 · 筛选 · 缩略图 | ✅ 完成 |
| M1+ 内置 Agent（server 直连本机设备） | ✅ 完成 |
| M1b iOS 设备发现 | ⬜ 待开始 |
| M2 Android scrcpy 投屏 + 控制 | ⬜ 待开始 |
| M3 iOS WDA 投屏 + 控制 | ⬜ 待开始 |
| M4 APK / IPA 安装 | ⬜ 待开始 |
| M5 任务队列 · 日志 · 部署 | ⬜ 待开始 |

## 环境要求

- Node.js ≥ 22（开发机实测 24.x）
- pnpm ≥ 9
- Android 设备宿主机：安装 [Android Platform Tools](https://developer.android.com/studio/releases/platform-tools)，确保 `adb` 在 PATH 中
- iOS 设备宿主机：Windows 需安装 iTunes / Apple Devices（提供 Apple Mobile Device Service），并安装 [go-ios](https://github.com/danielpaulus/go-ios)

先在宿主机自检环境：

```bash
pnpm --filter @adh/agent dev doctor
```

## 快速开始

```bash
pnpm install
pnpm dev            # server: 8080，web: 5173
```

打开 http://localhost:5173

### 0. server 本机设备（自动）

server 启动时会注册一个 id 固定为 `builtin-local` 的内置 Agent，直接在本进程内调用 adb：

- 不需要生成 Key，不需要额外进程
- 每 5 秒扫描 `adb devices`，每 30 秒截取缩略图
- 在 Agent 管理里显示为带「内置」标记的一行，不能删除、不能重置 Key
- 如果不想让 server 接管本机设备，设置环境变量 `ADH_LOCAL_AGENT=0`

### 1. 接入其它宿主机

左侧菜单进入 **Agent 管理 → 新建 Agent**，填写名称（例如「上海机房-01」）。

创建后会生成一个 **接入 Key** 和对应的命令，Key 只展示一次：

```bash
adh-agent connect --server ws://<hub地址>:8080 --key adh_xxxxxxxx
```

当前源码运行方式：

```bash
pnpm --filter @adh/agent dev connect --server ws://<hub地址>:8080 --key adh_xxxxxxxx
```

Key 会保存在宿主机的 `~/.adh/agent.json`，之后重启 agent 只需带 `--server`。

### 2. 连接设备

Agent 启动后每 5 秒扫描一次 `adb devices`，检测到新设备会立即采集硬件信息：

- 型号 / 品牌 / 系统版本 / SDK
- CPU 型号、核心数
- 内存总量
- 屏幕分辨率

随后每 30 秒截取一次屏幕缩略图上传到 server。

### 3. 在控制台筛选设备

设备管理页顶部支持组合筛选：

| 筛选项 | 说明 |
| --- | --- |
| 关键字 | 名称 / 型号 / 品牌 / UDID / CPU |
| 类型 | Android / iOS |
| 状态 | 在线 / 离线 / 未授权 |
| 系统版本 | 多选，选项从在线设备动态聚合，带数量 |
| CPU | 多选，按芯片型号聚合 |
| 内存 | 多选，按标称容量聚合（7.4GB → 8GB） |

所有筛选项都显示当前匹配数量，组合生效。

### 生产模式

```bash
pnpm build          # 前端产物输出到 apps/server/public
pnpm start          # 单进程托管 API + 前端
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 server 与 web |
| `pnpm dev:server` | 只启动 server |
| `pnpm dev:web` | 只启动 web |
| `pnpm --filter @adh/agent dev connect --server ... --key ...` | 启动节点 |
| `pnpm --filter @adh/agent dev doctor` | 检查 adb / go-ios / Apple 服务 |
| `pnpm -r typecheck` | 全量类型检查 |
| `pnpm build` | 构建前端 |

server 可用参数：`--port` `--host` `--data` `--log-level`，对应环境变量 `ADH_PORT` `ADH_HOST` `ADH_DATA_DIR` `ADH_LOG_LEVEL`。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 协议 | TypeScript + zod，两端共享 schema |
| Server | Fastify 5 + WebSocket + Drizzle ORM + SQLite |
| 设备采集 | `@adh/device-host`：adb CLI + sharp 缩略图压缩，server 与 agent 共用 |
| Agent | Node 22+，WebSocket 长连接、断线重连 |
| Web | Vue 3 + Naive UI + Vue Router + Vite |

## 目录结构

```
an-device-hub/
├─ packages/protocol/          两端共享的消息 schema 与二进制帧格式
├─ packages/device-host/       设备采集能力：adb 发现、硬件信息、截图压缩
│  ├─ src/android-discover.ts  设备枚举 + getprop/meminfo/cpuinfo 解析
│  ├─ src/android-screenshot.ts 截图并用 sharp 压成缩略图
│  └─ src/ios-discover.ts      iOS 发现（M1b 实现）
├─ apps/server/
│  ├─ src/local-agent.ts       内置本机 Agent（进程内直连 adb）
│  ├─ src/db/                  Drizzle schema + SQL 迁移
│  ├─ src/http/routes.ts       REST + 缩略图接口
│  ├─ src/ws/agent.ts          Agent 主通道：握手、心跳、设备同步
│  ├─ src/ws/web-hub.ts        浏览器实时事件 fan-out
│  └─ src/storage/thumbnails.ts 设备缩略图落盘
├─ apps/agent/
│  ├─ src/client.ts            长连接、心跳、重连、设备 diff 上报
│  └─ src/thumbnail-uploader.ts 缩略图 HTTP 上传
└─ apps/web/                   Vue 3 + Naive UI 控制台
   ├─ src/views/DevicesView.vue  设备网格 + 组合筛选
   ├─ src/views/AgentsView.vue   Agent 列表 + 新建/重置 Key/删除
   └─ src/stores/fleet.ts        实时设备/节点状态
```

`packages/device-host` 同时被 server 与 agent 复用，保证本机采集和远程采集的行为完全一致。

## 架构

```
浏览器 ──► adh-server ──◄── adh-agent ──► adb / go-ios ──► 设备
             │  │
             │  └─ 内置 Agent ──► adb ──► 本机设备
             │
             └─ SQLite + 缩略图 + 安装包存储
```

所有连接均由 agent 主动外连，因此 server 可以部署在公网，设备宿主机处于 NAT 后无需端口映射。
内置 Agent 不产生任何网络连接，直接进程内采集。

### 实时通道

| 通道 | 用途 |
| --- | --- |
| `/ws/agent` | 握手鉴权、心跳、设备增量同步、指令 RPC |
| `/ws/web` | 向浏览器推送节点/设备变更 |
| `/ws/stream/:id` | 投屏流中继（M2 启用） |

### 接入流程

1. server 启动 → 自动注册 `builtin-local`，开始扫描本机 adb 设备
2. 其它宿主机：Web 控制台创建 Agent → server 生成 `adh_` 前缀的 Key
3. 宿主机执行命令 → agent 用 Key 握手
4. Server 校验 Key → 绑定 Agent 记录、下发 welcome
5. Agent 每 5 秒上报设备 diff，每 30 秒上传缩略图
6. 浏览器通过 WebSocket 接收增量，无需轮询

## 已知限制

- 设备缩略图目前只支持 Android（iOS 缩略图随 M3 提供）
- iOS 设备发现留到 M1b（需要真实设备确认 go-ios 输出格式）
- Web 端无鉴权，仅适合内网部署
- 前端未做路由级代码分割，首屏包体约 224KB（gzip）