# 在其他电脑上接入 adh-agent

`adh-agent` 跑在**插着手机的电脑**（设备宿主机）上，主动外连 server，因此宿主机不需要公网 IP，也不用改路由器。

## 1. 准备安装包

在开发机 / server 上执行一次：

```bash
pnpm package:agent
```

产物：

| 路径 | 说明 |
| --- | --- |
| `dist/agent/` | 自包含目录，已带 tsx、sharp、scrcpy-server.jar |
| `dist/adh-agent-<platform>-<arch>.zip` | 约 15MB，直接发给别人 |

打包完成后，Web 控制台「节点管理 → 下载 Agent」也会直接下载这个 zip。

> `sharp` 带平台相关的原生二进制：Windows 上打的包只能给 Windows 用；给 Linux / macOS 分发时，在对应系统上重新执行一次 `pnpm package:agent`。

## 2. 目标电脑需要安装什么

只有三样：

1. **Node.js 22+** — https://nodejs.org
2. **adb 在 PATH 中** — [Android Platform Tools](https://developer.android.com/studio/releases/platform-tools)
   - Windows 还需要安装手机厂商的 USB 驱动（或 Google USB Driver）
   - 手机要打开「开发者选项 → USB 调试」，首次连接时在手机上点「允许」
3. **能访问 server 的 8080 端口** — 浏览器打开 `http://<server-ip>:8080` 能看到控制台即可

iOS 设备额外需要：

- **go-ios**（推荐）：https://github.com/danielpaulus/go-ios
- Windows 还需安装 iTunes / Apple Devices（提供 Apple Mobile Device Service + usbmuxd）

不需要安装 pnpm，也不需要拉源码。

## 3. 解压（安装）

把 zip 解压到任意目录，例如 `C:\adh-agent\`。目标机不需要安装 pnpm，也不需要拉源码。

Windows 用 `adh-agent.cmd`，Linux / macOS 用 `adh-agent.sh`。

## 4. 接入 server

Key 在 Web 控制台创建：**节点管理 → 新建节点**，创建后复制命令：

```bat
adh-agent.cmd connect --server ws://<server-ip>:8080 --key adh_xxxxxxxx
```

Linux / macOS：

```bash
./adh-agent.sh connect --server ws://<server-ip>:8080 --key adh_xxxxxxxx
```

连接成功后：

- 窗口日志出现 `adh-agent started`
- 设备 5 秒内出现在「设备管理」
- Key 保存在 `~/.adh/agent.json`，以后重启只需带 `--server`

## 5. 常驻运行

### Windows（计划任务）

1. 打开「任务计划程序」→ 创建任务
2. 触发器：登录时
3. 操作：启动程序 `C:\adh-agent\adh-agent.cmd`
4. 参数：`connect --server ws://<server-ip>:8080`
5. 勾选「不管用户是否登录都要运行」时，注意保持 `~/.adh/agent.json` 对应用户可读

### Linux（systemd）

`/etc/systemd/system/adh-agent.service`：

```ini
[Unit]
Description=ADH Agent
After=network-online.target

[Service]
Type=simple
User=adh
WorkingDirectory=/opt/adh-agent
ExecStart=/opt/adh-agent/adh-agent.sh connect --server ws://<server-ip>:8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now adh-agent
```

## 6. 可选：环境自检

接入前想确认 adb / go-ios 是否就绪，可以运行：

```bat
adh-agent.cmd doctor
```

```bash
./adh-agent.sh doctor
```

这一步不是必需的：`connect` 启动时也会检测 adb，缺 adb 会在日志里提示。
`libimobiledevice` 显示未安装是正常的（有 go-ios 即可）。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `doctor` 显示 adb 不可用 | 确认 `adb version` 能执行，并把 platform-tools 目录加入 PATH |
| 设备一直「未授权」 | 手机上重新插拔 USB，点「允许 USB 调试」，必要时删除授权后重试 |
| 连不上 server | 宿主机执行 `curl http://<server-ip>:8080/api/health`，检查防火墙 / 安全组 |
| 提示 Key 无效 | Key 只能显示一次；在控制台「重置 Key」后用新命令重新接入 |
| 设备不出现 | 确认 `adb devices` 能看到设备；`doctor` 通过后再看 agent 日志 |

## 8. 可选：私有 npm

不想发离线包时，可以搭 Verdaccio / GitHub Packages，把 `@adh/protocol`、`@adh/device-host`、`@adh/agent` 依次发布（先把 `workspace:*` 改成实际版本号），目标机 `npm i -g @adh/agent` 即可获得全局 `adh-agent` 命令。