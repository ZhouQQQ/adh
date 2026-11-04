# ADH · 分布式设备农场

把多台电脑上的 Android / iOS 真机集中到一个 Web 控制台：实时投屏、直接操作、批量安装。

- **adh-server**：Web 控制台 + 设备调度，用 Docker 部署在服务器上
- **adh-agent**：跑在插着手机的电脑上，主动外连 server，不需要公网 IP
- 存储默认 SQLite + 本地文件，也支持 MySQL + 阿里云 OSS

## 功能

| 模块 | 能力 |
| --- | --- |
| Android 控制 | scrcpy 实时画面、触摸/按键/文本、截图录屏、通知栏 |
| iOS 控制 | WDA 投屏（MJPEG）、点击滑动、多任务、音量、文本输入 |
| 应用管理 | APK / IPA 上传、图标、大小、安装时间、按平台安装 |
| 文件管理 | 浏览、上传、下载、多选打包 zip、预览、重命名 |
| 批量控制 | 多设备网格、跨平台联动、批量安装、系统级画中画 |
| 设备信息 | 电量、内存、存储、WiFi、硬件参数、实时状态图表 |

---

## 一、部署 server（Docker）

server 负责控制台、数据库、设备调度，本身**不需要连接手机**。
镜像由 GitHub Actions 自动构建并推送到 GHCR：

```
ghcr.io/zhouqqq/adh:latest
```

> 第一次拉取如果提示 `denied`，到 GitHub 仓库的 **Packages → adh → Package settings** 把可见性改成 **Public**，或者先 `docker login ghcr.io`。

### 1.1 直接运行（最简单）

```bash
docker pull ghcr.io/zhouqqq/adh:latest

docker run -d --name adh \
  -p 8080:8080 \
  -v adh-data:/data \
  -e ADH_DATA_DIR=/data \
  -e ADH_LOCAL_AGENT=0 \
  --restart unless-stopped \
  ghcr.io/zhouqqq/adh:latest
```

打开 `http://<服务器IP>:8080`，默认账号：

```
用户名：admin
密码：admin
```

首次登录后请在「系统设置 → 用户管理」里改掉密码。

### 1.2 docker compose（推荐）

`docker-compose.yml`：

```yaml
services:
  adh:
    image: ghcr.io/zhouqqq/adh:latest
    container_name: adh
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      ADH_DATA_DIR: /data
      # 容器里没有 USB，内置 Agent 关闭
      ADH_LOCAL_AGENT: "0"
    volumes:
      - adh-data:/data

volumes:
  adh-data:
```

```bash
docker compose up -d
docker compose logs -f
```

### 1.3 数据持久化

| 路径 | 内容 |
| --- | --- |
| `/data` | SQLite 数据库、安装包、缩略图、应用图标 |

**一定要挂卷**（`-v adh-data:/data`），否则容器重建后数据全丢。

### 1.4 接入 MySQL / OSS（可选）

默认用容器内的 SQLite，单机完全够用。需要外部数据库或对象存储时，加一个 `.env`：

```bash
# MySQL
MYSQL_HOST=192.168.1.20
MYSQL_PORT=3306
MYSQL_USER=adh
MYSQL_PASSWORD=你的密码
MYSQL_DB=adh

# 阿里云 OSS
ADH_OSS_BUCKET=your-bucket
ADH_OSS_REGION=oss-cn-shenzhen
ADH_OSS_ACCESS_KEY_ID=xxx
ADH_OSS_ACCESS_KEY_SECRET=xxx
ADH_OSS_PREFIX=adh
```

```bash
docker run -d --name adh \
  -p 8080:8080 \
  -v adh-data:/data \
  --env-file .env \
  -e ADH_DATA_DIR=/data \
  -e ADH_LOCAL_AGENT=0 \
  --restart unless-stopped \
  ghcr.io/zhouqqq/adh:latest
```

| 配置情况 | 数据库 | 文件 |
| --- | --- | --- |
| 什么都不配 | SQLite | `/data` |
| 配了 `MYSQL_HOST` | MySQL | `/data` |
| 配了 OSS | SQLite | OSS |
| 都配了 | MySQL | OSS |

也可以用 `ADH_DB=sqlite|mysql`、`ADH_STORAGE=local|oss` 强制指定。

---

## 二、运行 Agent（Windows / macOS）

Agent 跑在**插着手机的那台电脑**上，负责发现设备、上传缩略图、转发投屏流。
它只往外连 server 的 8080 端口，所以宿主机不需要公网 IP，也不用改路由器。

### 2.1 下载安装包

从 GitHub Release 下载对应平台（**滚动更新，始终是最新构建**）：

| 平台 | 下载地址 |
| --- | --- |
| Windows | <https://github.com/ZhouQQQ/adh/releases/download/agent-latest/adh-agent-win32.zip> |
| macOS | <https://github.com/ZhouQQQ/adh/releases/download/agent-latest/adh-agent-darwin.zip> |

发布页：<https://github.com/ZhouQQQ/adh/releases/tag/agent-latest>

也可以登录控制台，点右上角「**下载 Agent**」直接下。

安装包已经内置当前平台的 **adb** 和 **go-ios**，不需要另外安装。

### 2.2 宿主机前提

| 依赖 | 说明 |
| --- | --- |
| Node.js 22+ | 必须，<https://nodejs.org> |
| adb | 安装包已内置，`adh-agent init` 会解压到 `~/.adh/tools` |
| go-ios | 接 iPhone 时需要，同样已内置 |
| 网络 | 能访问 `http://<server-ip>:8080/api/health` |

### 2.3 在控制台创建 Key

控制台 →「**节点管理**」→「**新建节点**」→ 复制接入 Key（`adh_` 开头，只显示一次）。

### 2.4 Windows

1. 解压 `adh-agent-win32.zip` 到 `C:\adh-agent`
2. 安装 Node.js 22 或更新版本，新开命令行确认 `node -v`
3. 进入目录，初始化内置工具：

   ```bat
   cd C:\adh-agent
   adh-agent.cmd init
   ```

4. 连接 server：

   ```bat
   adh-agent.cmd connect --server ws://192.168.1.10:8080 --key adh_xxxxxxxx
   ```

5. 看到 `adh-agent started` 后，设备会在 5 秒内出现在控制台「设备管理」里。
   Key 会保存到 `%USERPROFILE%\.adh\agent.json`，以后重启只需：

   ```bat
   adh-agent.cmd connect --server ws://192.168.1.10:8080
   ```

**开机自启（计划任务）**

1. 打开「任务计划程序」→ 创建任务
2. 触发器：登录时
3. 操作：启动程序 `C:\adh-agent\adh-agent.cmd`
4. 参数：`connect --server ws://192.168.1.10:8080`

### 2.5 macOS

1. 解压 `adh-agent-darwin.zip` 到 `/opt/adh-agent`（或任意目录）
2. 安装 Node.js 22+：`brew install node@22`，或从官网安装
3. 如果系统提示「无法验证开发者」，解除隔离：

   ```bash
   xattr -dr com.apple.quarantine /opt/adh-agent
   ```

4. 初始化内置工具：

   ```bash
   cd /opt/adh-agent
   chmod +x adh-agent.sh
   ./adh-agent.sh init
   ```

5. 连接 server：

   ```bash
   ./adh-agent.sh connect --server ws://192.168.1.10:8080 --key adh_xxxxxxxx
   ```

**开机自启（launchd）**

`~/Library/LaunchAgents/com.adh.agent.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.adh.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/adh-agent/adh-agent.sh</string>
    <string>connect</string>
    <string>--server</string>
    <string>ws://192.168.1.10:8080</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/adh-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/adh-agent.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.adh.agent.plist
```

### 2.6 手机准备（简述）

**Android**

- 设置 → 关于手机 → 连续点「版本号」7 次，打开开发者选项
- 打开「USB 调试」和「USB 安装」
- 小米 / Redmi 还需要打开「USB 调试（安全设置）」
- 插上数据线，手机上点「允许 USB 调试」

**iOS**

- 插上数据线，手机上点「信任此电脑」
- iOS 16+ 需要打开「设置 → 隐私与安全性 → 开发者模式」
- WDA 安装和启动见文档

完整的设备配置、WDA 安装、常见问题见
[`docs/agent-install.md`](docs/agent-install.md)。

### 2.7 自检

```bat
adh-agent.cmd doctor
```

```bash
./adh-agent.sh doctor
```

会检查 Node、adb、go-ios 是否可用。

---

## 三、常见问题

| 现象 | 处理 |
| --- | --- |
| 控制台打不开 | 确认容器在跑、端口映射正确：`docker ps`、`curl http://<ip>:8080/api/health` |
| 登录提示账号密码错误 | 默认 `admin / admin`；忘记密码可删掉数据卷重新初始化 |
| Agent 连不上 server | 宿主机 `curl http://<server-ip>:8080/api/health`，检查防火墙 |
| 设备不出现 | 宿主机执行 `adb devices`，确认是 `device` 而不是 `unauthorized` |
| 小米能投屏但点不动 | 打开「USB 调试（安全设置）」，需要登录小米账号并等待 7 天 |
| 密码框弹不出键盘 | 关闭厂商的「安全输入」，并确认启用了输入法 |
| 下载 Agent 按钮不可用 | 服务器无法访问 GitHub Release，可挂载 `dist/` 使用本地包 |

---

## 四、本地开发（开发者）

```bash
pnpm install
pnpm dev          # server:8080  web:5173（HTTPS）
```

- 前端默认 HTTPS，局域网 IP 访问也能用 WebCodecs 解码安卓画面
- 自签证书首次访问需点「高级 → 继续前往」
- `ADH_HTTPS=0 pnpm dev` 可回退到 http

生产构建：

```bash
pnpm build        # 前端产物输出到 apps/server/public
pnpm start        # 单进程托管 API + 前端
```

自己打 Agent 离线包（不用 Release 时）：

```bash
pnpm package:agent --platform win32    # 或 darwin
```

产物在 `dist/adh-agent-<platform>.zip`。

### 服务端参数

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--port` | `ADH_PORT` | `8080` |
| `--host` | `ADH_HOST` | `0.0.0.0` |
| `--data` | `ADH_DATA_DIR` | `.data` |
| `--log-level` | `ADH_LOG_LEVEL` | `info` |
| — | `ADH_LOCAL_AGENT=0` | 关闭内置 Agent |
| — | `ADH_DB` | `sqlite` / `mysql` |
| — | `ADH_STORAGE` | `local` / `oss` |
| — | `ADH_AGENT_RELEASE_REPO` | `ZhouQQQ/adh`，自定义 Release 仓库 |
| — | `ADH_AGENT_RELEASE_TAG` | `agent-latest`，自定义 Release 标签 |

### 目录

```
apps/server/          API、WS、内置 Agent、OSS
apps/agent/           宿主机守护进程
apps/web/             Vue 控制台
packages/protocol/    消息 schema、H.264 工具
packages/device-host/ adb / scrcpy / iOS 采集
docs/                 设备接入与部署文档
```

## 账号与权限

首次启动会自动创建超级管理员 `admin / admin`：

- **超级管理员**：全部权限，可管理用户、查看审计日志
- **管理员**：设备、应用、文件等日常操作
- **普通用户**：控制设备，同时控制数量默认上限 2 台

所有 `/api` 接口和浏览器 WebSocket 都需要登录，Agent 使用 `adh_` 前缀的 key。

## 说明

- 内网工具，部署在可信网络中，不要直接暴露到公网
- 写操作自动记入审计日志；设备控制、按键、安装、文件操作记入设备日志
- iOS 的 WiFi SSID 系统不开放，只能显示 IP
- iOS 文件管理受限于 App 容器，且需要 `ios tunnel start`
- 离线包与平台相关，Windows / macOS 需要各自的 zip
