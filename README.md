# ADH · 分布式设备农场

把多台机器上的 Android / iOS 真机集中到一个 Web 控制台：实时投屏、直接操作、批量安装。

- `adh-server`：控制台 + 节点/设备管理，单进程托管前后端
- `adh-agent`：部署在设备宿主机，主动外连 server，自动上报本机设备
- server 内置本机 Agent，所在机器插上设备即可被发现

## 功能

| 模块 | 能力 |
| --- | --- |
| Android 控制 | scrcpy 实时画面、触摸/按键/文本、截图录屏、通知栏 |
| iOS 控制 | WDA 投屏（MJPEG）、点击滑动、多任务、音量、文本输入 |
| 应用管理 | APK / IPA 上传、图标、大小、安装时间、按平台安装 |
| 文件管理 | 浏览、上传、下载、多选打包 zip、预览、重命名 |
| 批量控制 | 多设备网格、跨平台联动、批量安装、系统级画中画 |
| 设备信息 | 电量、内存、存储、WiFi、硬件参数、实时状态图表 |

## 快速开始

```bash
pnpm install
pnpm dev          # web:5173  server:8080
```

生产模式：

```bash
pnpm build        # 前端产物输出到 apps/server/public
pnpm start        # 单进程托管 API + 前端
```

## 接入设备宿主机

1. 控制台「节点管理 → 新建节点」，复制接入 Key
2. 在宿主机执行：

```bash
adh-agent connect --server ws://<server-ip>:8080 --key adh_xxxxxxxx
```

如果目标机器没有安装包，在开发机打包后拷贝过去：

```bash
pnpm package:agent --platform win32    # 或 darwin
```

产物 `dist/adh-agent-win32.zip` / `dist/adh-agent-darwin.zip`，已内置当前平台的 adb 与 go-ios：

```bat
adh-agent.cmd init       :: 解压内置工具，无需联网
adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxxxxxxx
```

Linux / macOS 用 `./adh-agent.sh`。目标机只需要 **Node.js ≥ 22** 和能访问 8080 端口。
完整步骤见 [`docs/agent-install.md`](docs/agent-install.md)。

## 配置

服务端参数（CLI / 环境变量）：

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--port` | `ADH_PORT` | `8080` |
| `--host` | `ADH_HOST` | `0.0.0.0` |
| `--data` | `ADH_DATA_DIR` | `.data` |
| `--log-level` | `ADH_LOG_LEVEL` | `info` |
| — | `ADH_LOCAL_AGENT=0` | 关闭内置 Agent |

可选 OSS 存储，配置后安装包、缩略图、应用图标同步到 `adh/` 下，本地保留缓存：

```bash
ADH_OSS_BUCKET=
ADH_OSS_REGION=oss-cn-hangzhou
ADH_OSS_ACCESS_KEY_ID=
ADH_OSS_ACCESS_KEY_SECRET=
ADH_OSS_PREFIX=adh
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 协议 | TypeScript + zod 共享 schema |
| Server | Fastify 5 · SQLite (Drizzle) · WebSocket |
| Agent | Node 22+ · 长连接断线重连 |
| Web | Vue 3 · Naive UI · Vite |
| 采集 | adb / scrcpy-server · go-ios / WDA |

## 目录

```
apps/server/       API、WS、SQLite、内置 Agent、OSS
apps/agent/        宿主机守护进程
apps/web/          Vue 控制台
packages/protocol/ 消息 schema、H.264 工具
packages/device-host/ adb / scrcpy / iOS 采集
docs/              部署与接入文档
```

数据库表统一 `adh_` 前缀：`adh_agents`、`adh_devices`、`adh_packages`、`adh_migrations`。

## 说明

- 内网工具，Web 端无鉴权
- iOS 的 WiFi SSID 系统不开放，只能显示 IP
- iOS 文件管理受限于 App 容器，且需要 `ios tunnel start`
- 离线包与平台相关，Windows / macOS 需分别在对应系统打包