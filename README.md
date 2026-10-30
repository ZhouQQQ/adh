# ADH · 分布式设备农场

把散落在多台机器上的 Android / iOS 真机集中到一个 Web 控制台：实时查看屏幕、直接操作、批量安装应用。

- `adh-server`：Web 控制台 + 设备/节点管理，一个进程搞定
- `adh-agent`：部署在设备宿主机上，主动外连 server，自动上报本机设备

架构、协议与阶段计划见本文末尾。

## 当前进度

| 阶段 | 状态 |
| --- | --- |
| M0 脚手架 · 节点接入 · 设备发现 · 实时看板 | ✅ 完成 |
| M1 完整设备信息 / iOS 发现 | ⬜ 待开始 |
| M2 Android scrcpy 投屏 + 控制 | ⬜ 待开始 |
| M3 iOS WDA 投屏 + 控制 | ⬜ 待开始 |
| M4 APK / IPA 安装 | ⬜ 待开始 |
| M5 任务队列 · 日志 · 部署 | ⬜ 待开始 |

## 环境要求

- Node.js ≥ 22（开发机实测 24.x）
- pnpm ≥ 9
- Android 设备宿主机：安装 [Android Platform Tools](https://developer.android.com/studio/releases/platform-tools)，确保 `adb` 在 PATH 中
- iOS 设备宿主机：Windows 需安装 iTunes / Apple Devices（提供 Apple Mobile Device Service），并安装 [go-ios](https://github.com/danielpaulus/go-ios)

先自检节点环境：

```bash
pnpm --filter @adh/agent dev doctor
```

## 快速开始

```bash
pnpm install

# 启动 server + web（server: 8080，web: 5173）
pnpm dev
```

server 启动后会打印一次性注册码：

```
agent code   : ADH-XXXX-XXXX
connect      : adh-agent connect --server ws://<此机IP>:8080 --code ADH-XXXX-XXXX
```

在设备宿主机上接入：

```bash
# 首次接入（--code 只在第一次需要）
pnpm --filter @adh/agent dev connect --server ws://192.168.1.10:8080 --code ADH-XXXX-XXXX

# 之后直接用保存的 token
pnpm --filter @adh/agent dev connect --server ws://192.168.1.10:8080
```

token 保存在 `~/.adh/agent.json`。

打开 http://localhost:5173 ，节点与设备会在接入后自动出现，USB 插拔 5 秒内反映到页面。

### 生产模式

```bash
pnpm build                 # 前端产物输出到 apps/server/public
pnpm start                 # 单进程托管 API + 前端
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 server 与 web |
| `pnpm dev:server` | 只启动 server |
| `pnpm dev:web` | 只启动 web |
| `pnpm --filter @adh/agent dev connect --server ...` | 启动节点 |
| `pnpm --filter @adh/agent dev doctor` | 检查 adb / go-ios / Apple 服务 |
| `pnpm -r typecheck` | 全量类型检查 |
| `pnpm build` | 构建前端 |

server 可用参数：`--port` `--host` `--data` `--code` `--log-level`，对应环境变量 `ADH_PORT` `ADH_HOST` `ADH_DATA_DIR` `ADH_REGISTRATION_CODE` `ADH_LOG_LEVEL`。

## 目录结构

```
an-device-hub/
├─ packages/protocol/          两端共享的消息 schema（zod）与二进制帧格式
├─ apps/server/
│  ├─ src/db/                  Drizzle schema + SQL 迁移
│  ├─ src/ws/agent.ts          Agent 主通道：握手、心跳、设备同步
│  ├─ src/ws/web-hub.ts        浏览器实时事件 fan-out
│  └─ src/http/routes.ts       REST API
├─ apps/agent/
│  ├─ src/client.ts            长连接、心跳、重连、设备 diff 上报
│  ├─ src/android/discover.ts  adb 设备发现
│  └─ src/ios/                 iOS 发现（M1 实现）
└─ apps/web/                   React 控制台
```

## 架构

```
浏览器 ──► adh-server ──◄── adh-agent ──► adb / go-ios ──► 设备
             │
             └─ SQLite + 安装包存储
```

所有连接均由 agent 主动外连，因此 server 可以部署在公网，设备宿主机处于 NAT 后无需端口映射。

### 实时通道

| 通道 | 用途 |
| --- | --- |
| `/ws/agent` | 握手鉴权、心跳、设备增量同步、指令 RPC |
| `/ws/web` | 向浏览器推送节点/设备变更 |
| `/ws/stream/:id` | 投屏流中继（M2 启用） |

### 设备按需连接

只有打开控制页时才启动设备的投屏进程，页面关闭 30 秒后回收，避免宿主机长时间为多台设备编码。

## M0 验收项

- [x] `pnpm dev` 启动 server 与 web
- [x] server 启动打印一次性注册码
- [x] agent 用注册码接入并持久化 token，断线自动重连
- [x] `doctor` 报告 adb / go-ios / libimobiledevice / Apple 设备服务状态
- [x] Web 实时显示节点在线状态与设备数量变化

## 已知限制

- Web 端目前只做展示，控制页在 M2 提供
- iOS 设备发现留到 M1（需要真实设备确认 go-ios 输出格式）
- Web 端无鉴权，仅适合内网部署