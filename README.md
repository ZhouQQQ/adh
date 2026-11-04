# ADH · 分布式设备农场

把多台电脑上的 Android / iOS 真机集中到一个 Web 控制台：实时投屏、直接操作、批量安装。

- **adh-server**：Web 控制台 + 设备调度，Docker 部署在服务器上，本身不接手机
- **adh-agent**：装在插着手机的电脑上，主动外连 server，不需要公网 IP
- 默认 SQLite + 本地文件，可选 MySQL + 阿里云 OSS

| 模块 | 能力 |
| --- | --- |
| Android | scrcpy 实时画面、触摸/按键/文本、截图录屏、通知栏 |
| iOS | WDA 投屏、点击滑动、多任务、音量、文本输入 |
| 应用 | APK / IPA 上传、图标、大小、安装时间、按平台安装 |
| 文件 | 浏览、上传、下载、多选打包 zip、预览、重命名 |
| 批量 | 多设备网格、跨平台联动、批量安装、系统级画中画 |
| 信息 | 电量、内存、存储、WiFi、硬件参数、实时状态图表 |

---

## 一、部署 server

一条命令，原样复制即可：

```bash
docker run -d --name adh \
  -p 8080:8080 \
  -v adh-data:/data \
  -e ADH_DATA_DIR=/data \
  -e ADH_LOCAL_AGENT=0 \
  --restart unless-stopped \
  ghcr.io/zhouqqq/adh:latest
```

浏览器打开 `http://<服务器IP>:8080`，默认账号 `admin / admin`，**登录后到「系统设置 → 用户管理」改掉密码**。

- 数据全在 `adh-data` 卷（容器内 `/data`），删容器不丢；**别去掉 `-v` 挂载**
- 升级：`docker pull ghcr.io/zhouqqq/adh:latest` → `docker rm -f adh` → 重跑上面的命令
- `ADH_LOCAL_AGENT=0` 表示关掉容器内置 Agent（容器里没有 USB）
- 8080 被占用时把 `-p 8080:8080` 改成 `-p 9000:8080`，用 `http://<服务器IP>:9000` 访问

### 或者用 docker compose

仓库里的 `docker-compose.yml` 已经配好：

```bash
docker compose up -d
docker compose logs -f
```

### 可选：外接 MySQL / OSS

单机默认 SQLite 就够用。需要外接时，写一个 `.env`，启动时加 `--env-file .env`：

```bash
# .env
MYSQL_HOST=192.168.1.20
MYSQL_PORT=3306
MYSQL_USER=adh
MYSQL_PASSWORD=你的密码
MYSQL_DB=adh

# 阿里云 OSS（不用可不写）
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

### 可选参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADH_PORT` | `8080` | 监听端口 |
| `ADH_HOST` | `0.0.0.0` | 监听地址 |
| `ADH_DATA_DIR` | `.data` | 数据目录 |
| `ADH_LOG_LEVEL` | `info` | 日志级别 |
| `ADH_LOCAL_AGENT` | `1` | 设为 `0` 关闭内置 Agent |
| `ADH_DB` | `sqlite` | `sqlite` / `mysql` |
| `ADH_STORAGE` | `local` | `local` / `oss` |

---

## 二、接入设备（Agent）

Agent 跑在**插着手机的那台电脑**上，只往外连 server 的 8080，宿主机不需要公网 IP。

**1. 建 Key**：控制台 →「节点管理」→「新建节点」，复制 `adh_` 开头的 Key（只显示一次）。

**2. 下载 Agent**（已内置 adb 和 go-ios，不用另外装）：

| 平台 | 下载地址 |
| --- | --- |
| Windows | <https://github.com/ZhouQQQ/adh/releases/download/agent-latest/adh-agent-win32.zip> |
| macOS | <https://github.com/ZhouQQQ/adh/releases/download/agent-latest/adh-agent-darwin.zip> |

也可以登录控制台，点右上角「下载 Agent」直接下。

**3. 跑起来**（唯一外部依赖是 Node.js 22+，解压到任意目录）：

Windows，解压到 `C:\adh-agent`：

```bat
cd C:\adh-agent
adh-agent.cmd init
adh-agent.cmd connect --server ws://<服务器IP>:8080 --key adh_xxxxxxxx
```

macOS，解压到 `/opt/adh-agent`：

```bash
cd /opt/adh-agent
chmod +x adh-agent.sh
./adh-agent.sh init
./adh-agent.sh connect --server ws://<服务器IP>:8080 --key adh_xxxxxxxx
```

看到 `adh-agent started` 就成功了，设备 5 秒内出现在「设备管理」。

Key 会存到 `~/.adh/agent.json`，之后重启只需要带 `--server`：

```bat
adh-agent.cmd connect --server ws://<服务器IP>:8080
```

```bash
./adh-agent.sh connect --server ws://<服务器IP>:8080
```

macOS 提示「无法验证开发者」时，先解除隔离再执行：

```bash
xattr -dr com.apple.quarantine /opt/adh-agent
```

**4. 手机侧**

- Android：连续点「版本号」7 次打开开发者选项 → 开启「USB 调试」和「USB 安装」→ 插线后手机点「允许 USB 调试」
- 小米 / Redmi：额外打开「USB 调试（安全设置）」，否则能投屏但点不动
- iOS：目前要求设备直接插在 server 所在机器上（内置 Agent），远程 Agent 只支持 Android

开机自启、WDA 安装、Linux 宿主机等细节见 [`docs/agent-install.md`](docs/agent-install.md)。

---

## 三、常见问题

| 现象 | 处理 |
| --- | --- |
| 控制台打不开 | `docker ps` 看容器在不在，`curl http://<服务器IP>:8080/api/health` |
| 忘记密码 | 默认 `admin / admin`；进不去就删掉数据卷重新初始化 |
| Agent 连不上 server | 在宿主机 `curl http://<服务器IP>:8080/api/health`，检查防火墙 |
| 设备不出现 | 宿主机执行 `adb devices`，要显示 `device` 而不是 `unauthorized` |
| 小米能投屏但点不动 | 打开「USB 调试（安全设置）」，需登录小米账号并等待 7 天 |
| 密码框弹不出键盘 | 关掉厂商的「安全输入」，并确认启用了输入法 |
| 下载 Agent 按钮不可用 | 服务器访问不了 GitHub，可挂载 `dist/` 用本地包 |

---

## 四、本地开发

```bash
pnpm install
pnpm dev        # server:8080 + web:5173（HTTPS，WebCodecs 需要安全上下文）
pnpm build      # 前端产物输出到 apps/server/public
pnpm start      # 单进程托管 API + 前端
pnpm package:agent --platform win32   # 打离线 Agent 包，产物在 dist/
```

- `ADH_HTTPS=0 pnpm dev` 可回退到 http
- 自签证书首次访问点「高级 → 继续前往」

目录结构：

```
apps/server/          API、WS、内置 Agent、OSS
apps/agent/           宿主机守护进程
apps/web/             Vue 控制台
packages/protocol/    消息 schema、H.264 工具
packages/device-host/ adb / scrcpy / iOS 采集
docs/                 设备接入与部署文档
```

## 账号与权限

首次启动自动创建超级管理员 `admin / admin`：

- **超级管理员**：全部权限，可管理用户、查看审计日志
- **管理员**：设备、应用、文件等日常操作
- **普通用户**：控制设备，同时控制数量默认上限 2 台

所有 `/api` 接口和浏览器 WebSocket 都需要登录，Agent 用 `adh_` 前缀的 Key 鉴权。

## 说明

- 内网工具，请部署在可信网络，不要直接暴露到公网
- 写操作自动记入审计日志；设备控制、按键、安装、文件操作记入设备日志
- iOS 的 WiFi SSID 系统不开放，只能显示 IP
- iOS 文件管理受限于 App 容器，且需要 `ios tunnel start`
- Agent 离线包与平台相关，Windows / macOS 需要各自的 zip
