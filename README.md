# ADH · 分布式设备农场

把多台机器上的 Android / iOS 真机集中到一个 Web 控制台：实时投屏、直接操作、批量安装。

- `adh-server`：控制台 + 节点/设备管理，单进程托管前后端
- `adh-agent`：部署在设备宿主机，主动外连 server，自动上报本机设备
- 数据存 MySQL，安装包 / 缩略图 / 图标存阿里云 OSS（`adh/` 目录）

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

先准备配置（数据库和 OSS 均为必填）：

```bash
cp .env.example .env
```

```bash
pnpm install
pnpm dev          # web:5173  server:8080
```

生产模式：

```bash
pnpm build        # 前端产物输出到 apps/server/public
pnpm start        # 单进程托管 API + 前端
```

首次启动会自动建表（`adh_agents` / `adh_devices` / `adh_packages` / `adh_migrations`）。

## Docker

```bash
./build.sh                 # 默认 adh-server:latest
IMAGE=adh/adh-server:v1 ./build.sh
```

```bash
docker compose up -d
```

`docker-compose.yml` 会读取 `.env`，数据落在 `adh-data` 卷的 `/data`。

单独运行：

```bash
docker run -d --name adh \
  -p 8080:8080 \
  --env-file .env \
  -e ADH_DATA_DIR=/data \
  -e ADH_LOCAL_AGENT=0 \
  -v adh-data:/data \
  -v "$(pwd)/dist:/app/dist:ro" \
  adh-server:latest
```

- 容器里没有 USB，内置 Agent 默认关闭，设备宿主机单独跑 `adh-agent connect`
- 挂载 `dist/` 后，控制台才能下载 Agent 离线包
- 镜像地址：`ghcr.io/<owner>/adh:latest`（由 GitHub Actions 构建）

## 接入设备宿主机

1. 控制台「节点管理 → 新建节点」，复制接入 Key
2. 在宿主机执行：

```bash
adh-agent connect --server ws://<server-ip>:8080 --key adh_xxxxxxxx
```

没有安装包时，在开发机打包后拷贝过去：

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

MySQL（必填）：

| 参数 | 说明 |
| --- | --- |
| `MYSQL_HOST` | 数据库地址 |
| `MYSQL_PORT` | 端口，默认 `3306` |
| `MYSQL_USER` | 用户名 |
| `MYSQL_PASSWORD` | 密码 |
| `MYSQL_DB` | 数据库名 |

阿里云 OSS：

| 参数 | 说明 |
| --- | --- |
| `ADH_OSS_BUCKET` | bucket 名称 |
| `ADH_OSS_REGION` | 区域，`cn-shenzhen` 会自动补成 `oss-cn-shenzhen` |
| `ADH_OSS_ACCESS_KEY_ID` | AccessKey |
| `ADH_OSS_ACCESS_KEY_SECRET` | Secret |
| `ADH_OSS_PREFIX` | 对象根目录，默认 `adh` |
| `ADH_OSS_ENDPOINT` | 可选，自定义 endpoint |

也兼容 `OSS_BUCKET_NAME` / `OSS_REGION_ID` / `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`。

对象路径：

```
adh/packages/<sha256>.<apk|ipa>
adh/thumbnails/<deviceId>.jpg
adh/app-icons/<hash>.png
```

服务端参数：

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--port` | `ADH_PORT` | `8080` |
| `--host` | `ADH_HOST` | `0.0.0.0` |
| `--data` | `ADH_DATA_DIR` | `.data` |
| `--log-level` | `ADH_LOG_LEVEL` | `info` |
| — | `ADH_LOCAL_AGENT=0` | 关闭内置 Agent |

## 数据迁移

从旧版 SQLite 迁移到 MySQL，并把本地文件同步到 OSS：

```bash
pnpm migrate:data
```

读取 `.data/adh.sqlite`、`.data/packages`、`.data/thumbnails`、`.data/app-icons`，可重复执行。

## GitHub Actions

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| `.github/workflows/docker.yml` | push main / tag / PR | 镜像推送到 GHCR |
| `.github/workflows/agent.yml` | push main / tag / PR | Windows + macOS Agent 离线包 |

打 tag（例如 `git tag v1.0.0 && git push origin v1.0.0`）会把两个平台的 Agent zip 上传到 GitHub Release。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 协议 | TypeScript + zod 共享 schema |
| Server | Fastify 5 · MySQL 8 (Drizzle) · WebSocket |
| Agent | Node 22+ · 长连接断线重连 |
| Web | Vue 3 · Naive UI · Vite |
| 存储 | 阿里云 OSS |
| 采集 | adb / scrcpy-server · go-ios / WDA |

## 目录

```
apps/server/         API、WS、MySQL、内置 Agent、OSS
apps/agent/          宿主机守护进程
apps/web/            Vue 控制台
packages/protocol/   消息 schema、H.264 工具
packages/device-host/ adb / scrcpy / iOS 采集
docs/                部署与接入文档
```

## 说明

- 内网工具，Web 端无鉴权
- iOS 的 WiFi SSID 系统不开放，只能显示 IP
- iOS 文件管理受限于 App 容器，且需要 `ios tunnel start`
- 离线包与平台相关，Windows / macOS 需分别在对应系统打包