# ADH · 分布式设备农场

把多台电脑上的 Android / iOS 真机集中到一个 Web 控制台：实时投屏、直接操作、批量安装。

- **adh-server**：Web 控制台 + 设备调度
- **adh-agent**：装在插着手机的电脑上，主动外连 server，不需要公网 IP

| 模块 | 能力 |
| --- | --- |
| Android | scrcpy 实时画面、触摸/按键/文本、截图录屏、通知栏 |
| iOS | WDA 投屏、点击滑动、多任务、音量、文本输入 |
| 应用 | APK / IPA 上传、图标、大小、安装时间、按平台安装 |
| 文件 | 浏览、上传、下载、多选打包 zip、预览、重命名 |
| 批量 | 多设备网格、跨平台联动、批量安装、系统级画中画 |
| 信息 | 电量、内存、存储、WiFi、硬件参数、实时状态图表 |

---

## 快速开始（单机）

server 和内置 Agent 跑在同一台电脑上，插上手机就能用。

### 1. 下载并启动 server

从 [Release](https://github.com/ZhouQQQ/adh/releases) 下载对应平台的离线包，目标机只需要 **Node.js 22+**：

| 平台 | 文件 |
| --- | --- |
| Linux | `adh-server-linux.zip` |
| Windows | `adh-server-win32.zip` |
| macOS | `adh-server-darwin.zip` |

```bash
unzip adh-server-linux.zip
cd server-linux
./start.sh
```

Windows 解压后执行 `start.cmd`。

> CI 目前只自动发布 Linux 包。Windows / macOS 包需要在对应系统上执行 `pnpm package:server --platform win32`（或 `darwin`）生成。

### 2. 打开控制台

浏览器访问 `http://127.0.0.1:8080`，默认账号 `admin / admin`。

登录后到「系统设置 → 用户管理」改掉密码。

### 3. 插上手机

内置 Agent 默认开启，设备会在 5 秒内出现在「设备管理」：

- Android：连续点「版本号」7 次打开开发者选项 → 开启「USB 调试」「USB 安装」→ 插线后手机上点「允许 USB 调试」
- iOS：插线后在设备菜单里点「启动 WDA」，首次会自动安装并拉起 WebDriverAgent

改端口或数据目录：

```bash
./start.sh --port 9000 --data /var/lib/adh
```

---

## 生产环境（分布式）

server 部署在服务器（Docker），每台插手机的电脑跑一个 Agent。

### 1. 启动 server

```bash
docker run -d --name adh \
  -p 8080:8080 \
  -v adh-data:/data \
  -e ADH_DATA_DIR=/data \
  -e ADH_LOCAL_AGENT=0 \
  --restart unless-stopped \
  ghcr.io/zhouqqq/adh:latest
```

国内可用阿里云镜像：`registry.cn-shenzhen.aliyuncs.com/xiaoantest/adh-server:latest`。

浏览器打开 `http://<服务器IP>:8080`，默认 `admin / admin`。

- 数据都在 `adh-data` 卷里，**不要去掉 `-v`**
- 服务器上没有 USB，所以 `ADH_LOCAL_AGENT=0` 关掉内置 Agent
- 升级：`docker pull` 新镜像 → `docker rm -f adh` → 重跑上面的命令

### 2. 创建 Agent Key

控制台 →「节点管理」→「新建节点」→ 复制 `adh_` 开头的 Key（只显示一次）。

### 3. 在设备宿主机运行 Agent

从 [Release](https://github.com/ZhouQQQ/adh/releases) 下载，已内置 adb 和 go-ios：

| 平台 | 文件 |
| --- | --- |
| Windows | `adh-agent-win32.zip` |
| macOS | `adh-agent-darwin.zip` |
| Linux | `adh-agent-linux.zip` |

也可以登录控制台，点右上角「下载 Agent」。

**Windows**（解压到 `C:\adh-agent`）：

```bat
cd C:\adh-agent
adh-agent.cmd init
adh-agent.cmd connect --server ws://<服务器IP>:8080 --key adh_xxxxxxxx
```

**macOS / Linux**：

```bash
cd /opt/adh-agent
chmod +x adh-agent.sh
./adh-agent.sh init
./adh-agent.sh connect --server ws://<服务器IP>:8080 --key adh_xxxxxxxx
```

看到 `adh-agent started` 就成功了；多台宿主机重复第 2、3 步即可。

- Key 会保存到 `~/.adh/agent.json`，之后重启只带 `--server`
- macOS 提示「无法验证开发者」时先执行 `xattr -dr com.apple.quarantine /opt/adh-agent`
- server 配了 `ADH_BASE_PATH` 时，`--server` 要带上同样前缀，如 `ws://<服务器IP>:8080/adh`
- iOS 也可以接在任意宿主机（含远程 Agent），在设备菜单里启动 WDA 即可；Windows 宿主机需先安装 iTunes 或「Apple Devices」

开机自启、WDA 安装等细节见 [`docs/agent-install.md`](docs/agent-install.md)。

### 可选：外接 MySQL / OSS

默认 SQLite + 本地文件就够用。需要外接时写 `.env`，启动加 `--env-file .env`：

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

### 可选参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADH_PORT` | `8080` | 监听端口 |
| `ADH_DATA_DIR` | `.data` | 数据目录 |
| `ADH_LOCAL_AGENT` | `1` | 设为 `0` 关闭内置 Agent |
| `ADH_DB` | `sqlite` | `sqlite` / `mysql` |
| `ADH_STORAGE` | `local` | `local` / `oss` |
| `ADH_BASE_PATH` | 空 | 部署前缀，例如 `/adh` |

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 控制台打不开 | `docker ps` 看容器在不在，`curl http://<服务器IP>:8080/api/health` |
| 忘记密码 | 默认 `admin / admin`；进不去就删掉数据卷重新初始化 |
| Agent 连不上 server | 在宿主机 `curl http://<服务器IP>:8080/api/health`，检查防火墙 |
| 设备不出现 | 宿主机执行 `adb devices`，要显示 `device` 而不是 `unauthorized` |
| 小米能投屏但点不动 | 打开「USB 调试（安全设置）」，需登录小米账号并等待 7 天 |
| 密码框弹不出键盘 | 关掉厂商的「安全输入」，并确认启用了输入法 |
| 下载 Agent 按钮不可用 | 服务器访问不了 GitHub，可挂载本地 `dist/` 目录 |

---

## 本地开发

```bash
pnpm install
pnpm dev              # server:8080 + web:5173（HTTPS）
pnpm build            # 前端产物到 apps/server/public
pnpm start            # 单进程托管 API + 前端
pnpm package:agent    # 打三平台 Agent 包
pnpm package:server --platform linux   # 打离线 server 包
```

- `ADH_HTTPS=0 pnpm dev` 可回退到 http
- 模拟子路径部署时两个进程都设 `ADH_BASE_PATH=/adh`，访问 <http://localhost:5173/adh/>

目录结构：

```
apps/server/          API、WS、内置 Agent、OSS
apps/agent/           宿主机守护进程
apps/web/             Vue 控制台
packages/protocol/    消息 schema、H.264 工具
packages/device-host/ adb / scrcpy / iOS 采集
docs/                 设备接入与部署文档
```

## 说明

- 内网工具，请部署在可信网络，不要直接暴露到公网
- 写操作自动记入审计日志；设备控制、安装、文件操作记入设备日志
- iOS 的 WiFi SSID 系统不开放，只能显示 IP
- iOS 文件管理受限于 App 容器，且需要 `ios tunnel start`
