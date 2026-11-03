# Agent 与手机接入指南

`adh-agent` 跑在**插着手机的电脑**（设备宿主机）上，主动外连 server，因此宿主机不需要公网 IP，也不用改路由器。

本文覆盖：

- Windows / macOS / Linux 宿主机需要准备的环境
- Android 手机的开发者选项与输入法配置
- iOS 手机如何启动 WebDriverAgent（WDA）
- Agent 的安装、接入与常驻运行

---

## 1. 平台环境对照

| 依赖 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Node.js 22+ | 必须 | 必须 | 必须 |
| adb（Android Platform Tools） | 必须（或用安装包内置） | 必须（或用安装包内置） | 必须（或用安装包内置） |
| 手机厂商 USB 驱动 | 部分品牌需要 | 不需要 | 一般不需要 |
| go-ios（iOS 设备） | 需要 | 需要 | 需要 |
| Apple 设备服务 | iTunes 或「Apple Devices」 | 系统自带 | 需要 usbmuxd |
| pnpm / 源码 | 不需要 | 不需要 | 不需要 |

> 离线安装包 `dist/adh-agent-<platform>-<arch>.zip` 已经内置当前平台的 adb 与 go-ios，运行 `adh-agent init` 会解压到 `~/.adh/tools`，**不需要联网**。系统里已经装好的话可以忽略。

---

## 2. 准备安装包

在开发机 / server 上执行一次：

```bash
pnpm package:agent
```

产物：

| 路径 | 说明 |
| --- | --- |
| `dist/agent/` | 自包含目录，已带 tsx、sharp、scrcpy-server.jar |
| `dist/agent/vendor/<platform>/` | 当前平台的 adb / go-ios 压缩包，init 时离线解压 |
| `dist/adh-agent-<platform>-<arch>.zip` | 约 32MB，直接发给别人 |

打包完成后，Web 控制台「节点管理 → 下载 Agent」也会直接下载这个 zip。

> `sharp` 与 `vendor` 都是平台相关的：Windows 上打的包只能给 Windows 用；给 Linux / macOS 分发时，在对应系统上重新执行一次 `pnpm package:agent`。

---

## 3. Windows 宿主机

### 3.1 必装

1. **Node.js 22 或更高版本**
   - 官网安装包：https://nodejs.org
   - 安装后新开一个命令行，确认 `node -v` 输出 `v22` 以上

2. **adb（Android Platform Tools）**
   - 下载：https://developer.android.com/studio/releases/platform-tools
   - 解压后把目录加入 `PATH`，确认 `adb version` 能执行
   - 也可以完全跳过：`adh-agent init` 会从安装包里解压一份到 `~/.adh/tools`

3. **手机 USB 驱动**
   - 小米 / OPPO / vivo / 荣耀等品牌，建议装官方助手或驱动
   - 通用方案：Google USB Driver（设备管理器里给「未知设备」更新驱动）

### 3.2 接 iOS 时额外需要

1. **go-ios**
   - 下载：https://github.com/danielpaulus/go-ios/releases
   - 解压后把 `ios.exe` 所在目录加入 `PATH`，确认 `ios version`
   - 或者交给 `adh-agent init` 自动解压

2. **Apple 设备服务**
   - 安装 iTunes（Apple 官网版）或 Microsoft Store 的「Apple Devices」
   - 它会安装 `Apple Mobile Device Service` 和 usbmuxd，go-ios 依赖它识别 iPhone
   - 安装后确认服务已启动：`services.msc` → Apple Mobile Device Service

### 3.3 防火墙

确保宿主机能访问 server 的 `8080`：

```bat
curl http://<server-ip>:8080/api/health
```

---

## 4. macOS 宿主机

### 4.1 必装

1. **Node.js 22+**

   ```bash
   brew install node@22
   # 或者从 https://nodejs.org 安装
   ```

2. **adb**

   ```bash
   brew install --cask android-platform-tools
   adb version
   ```

   也可以让 `adh-agent init` 使用安装包内的 adb。

3. **iOS 相关**
   - macOS 自带 usbmuxd，不需要 iTunes
   - go-ios：

     ```bash
     brew install go-ios
     ios version
     ```

   - 如果要自己编译 / 跑 WDA，建议装 Xcode（App Store，体积较大）

### 4.2 权限

- 首次连接 iPhone，手机会弹出「要信任此电脑吗」，点**信任**并输入锁屏密码
- macOS 可能提示「允许配件连接」，需要在「系统设置 → 隐私与安全性」里允许
- 建议把终端 / 启动器加入「完全磁盘访问」和「输入监控」，避免自动化操作被拦截

### 4.3 Linux 宿主机（可选）

```bash
sudo apt install android-tools-adb usbmuxd
# go-ios 从 release 下载对应二进制
```

Linux 下 udev 规则和 USB 权限需要额外配置，非首选平台。

---

## 5. Android 手机配置

以下步骤以原生 Android 为例，国产 ROM 的入口名称略有差异。

### 5.1 打开开发者选项

1. 设置 → 关于手机
2. 连续点击「版本号」7 次，直到提示「已进入开发者模式」
3. 返回设置 → 系统 → 开发者选项

### 5.2 开启调试相关开关

| 开关 | 作用 |
| --- | --- |
| **USB 调试** | 必须，adb 连接的前提 |
| **USB 安装** | 允许通过 adb 安装 APK（部分 ROM 叫「通过 USB 安装应用」） |
| **USB 调试（安全设置）** | 小米 / Redmi 必须额外打开，否则无法模拟点击 |
| **停用 adb 授权超时** | 可选，避免长时间后重新授权 |
| **保持唤醒** | 可选，充电时不熄屏，方便调试 |

小米 / Redmi 打开「USB 调试（安全设置）」通常要求：登录小米账号 + 插入 SIM 卡 + 等待 7 天。可以先用普通 USB 调试验证投屏，再补这一步。

### 5.3 首次连接授权

1. 数据线连接电脑（优先主板后置 USB 口，不要用 Hub）
2. 手机弹出「允许 USB 调试吗」，勾选「始终允许」并点确定
3. 电脑执行：

   ```bash
   adb devices
   ```

   看到 `device` 而不是 `unauthorized` 才算成功。

如果一直是 `unauthorized`：

```bash
adb kill-server
adb start-server
```

然后在手机上撤销 USB 调试授权，重新插拔。

### 5.4 安全键盘 / 安全输入

部分 ROM 在密码框会启用「安全输入」，会**禁用第三方输入法和 adb 模拟输入**，表现为点密码框后虚拟键盘弹不出来，或者脚本输入无效。

关闭方式（按品牌）：

| 品牌 | 路径 |
| --- | --- |
| 小米 / Redmi | 设置 → 密码与安全 → 系统安全 → 安全输入（关闭） |
| OPPO / 一加 / realme | 设置 → 权限与隐私 → 系统安全 → 安全输入（关闭） |
| vivo / iQOO | 设置 → 安全 → 更多安全设置 → 安全输入（关闭） |
| 华为 / 荣耀 | 设置 → 安全 → 更多安全设置 → 安全输入（关闭） |

找不到时可以在设置里搜索「安全输入」。

另外两项也会影响输入：

- **输入法**：安装并启用至少一个系统输入法，否则投屏里点输入框不会弹键盘
- **自动填充**：如果密码框总是弹系统密码保险箱，可以在「设置 → 密码与账号」里关闭对应服务的自动填充

### 5.5 电池与后台

为了避免 adb 连接被系统回收：

- 设置 → 电池 → 找到对应应用 → 允许后台运行 / 关闭省电策略
- 开发者选项里打开「保持唤醒」
- 不要开启「USB 调试自动断连」类省电模式

### 5.6 项目会自动处理的

- 建立 scrcpy 会话时自动执行 `settings put system show_touches 1`，会话结束恢复原值，不需要手动开「显示触摸操作」
- 投屏使用的 scrcpy-server.jar 已内置，不需要单独安装

---

## 6. iOS 手机配置（WDA）

> iOS 目前要求设备连接在 **server 所在机器**上（内置 Agent）。WDA 的 8100 端口转发由 server 自动建立，远程 Agent 暂不支持 iOS。

### 6.1 准备工作

1. 数据线连接电脑，手机点「信任此电脑」
2. 确认 go-ios 能识别设备：

   ```bash
   ios list
   ```

   输出类似：

   ```json
   {"deviceList":["00008030-000E245636E0802E"]}
   ```

3. iOS 16 及以上需要打开开发者模式：
   - 设置 → 隐私与安全性 → 开发者模式
   - 打开后设备会重启，重启后再次确认开启

### 6.2 安装并启动 WDA

go-ios 提供两种方式。

**方式一：自动下载并启动（推荐）**

```bash
ios ui download wda
ios ui run wda
```

**方式二：使用已签名的 WDA**

如果你已经有签好的 `WebDriverAgentRunner.xctrunner`：

```bash
ios runwda \
  --udid=<设备 UDID> \
  --bundleid=com.facebook.WebDriverAgentRunner.xctrunner.XXXX \
  --testrunnerbundleid=com.facebook.WebDriverAgentRunner.xctrunner.XXXX \
  --xctestconfig=WebDriverAgentRunner.xctest
```

启动成功的标志：

- 终端出现 `Running wda`、`authorized`
- 手机屏幕出现「Automation Running」提示
- 本机访问 `http://127.0.0.1:8100/status` 返回 `state: success`

### 6.3 端口转发

WDA 默认监听设备侧的 8100，需要转发到本机：

- server 检测到 iOS 设备后会自动执行 `ios forward 8100 8100 --udid=<udid>`
- 手动执行也可以：

  ```bash
  ios forward 8100 8100 --udid=<udid>
  ```

如果 server 和 WDA 不在同一台机器，可以用环境变量指定地址：

```bash
ADH_WDA_URL=http://<wda-host>:8100
```

### 6.4 保持 WDA 运行

`ios runwda` 是前台进程，终端关闭就退出。建议：

- 用 `tmux` / `screen` 保持会话
- 或者用计划任务 / systemd 守护，退出后自动重启
- USB 掉线会导致 WDA 退出，日志里是 `conn closed unexpectedly` / `lost connection to testmanagerd`，重新插拔后重新执行启动命令即可

### 6.5 iOS 键盘说明

- 密码框会启用系统的**安全键盘**，第三方输入法被禁用，这是 iOS 行为，无法关闭
- 安全键盘在**截图 / 录屏 / 投屏**里会被系统抹掉，所以 Web 画面上看不到键盘，但真机是正常显示的
- 需要输入文字时，用控制页的「发送文本」直接写入，不依赖设备键盘

---

## 7. 解压并安装 Agent

把 zip 解压到任意目录，例如 `C:\adh-agent\`。目标机不需要安装 pnpm，也不需要拉源码。

Windows 用 `adh-agent.cmd`，Linux / macOS 用 `adh-agent.sh`。

如果还没有 adb / go-ios，可以让 agent 自己装：

```bat
adh-agent.cmd init
```

```bash
./adh-agent.sh init
```

`init` 会：

- 优先使用安装包 `vendor/<platform>/` 里内置的 Android Platform Tools 与 go-ios（离线，不联网）
- 解压到 `~/.adh/tools/`，之后 agent 启动时自动把它前置到 PATH
- 只有在打包时用了 `--no-vendor`，才会回退到联网下载

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--skip-ios` | 只装 adb |
| `--skip-android` | 只装 go-ios |
| `--force` | 重新解压覆盖 |

---

## 8. 接入 server

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

---

## 9. 常驻运行

### 9.1 Windows（计划任务）

1. 打开「任务计划程序」→ 创建任务
2. 触发器：登录时
3. 操作：启动程序 `C:\adh-agent\adh-agent.cmd`
4. 参数：`connect --server ws://<server-ip>:8080`
5. 勾选「不管用户是否登录都要运行」时，注意保持 `~/.adh/agent.json` 对应用户可读

### 9.2 macOS（launchd）

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
    <string>ws://&lt;server-ip&gt;:8080</string>
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

### 9.3 Linux（systemd）

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

---

## 10. 环境自检

接入前想确认 adb / go-ios 是否就绪：

```bat
adh-agent.cmd doctor
```

```bash
./adh-agent.sh doctor
```

`libimobiledevice` 显示未安装是正常的（有 go-ios 即可）。

---

## 11. 常见问题

| 现象 | 处理 |
| --- | --- |
| `doctor` 显示 adb 不可用 | 确认 `adb version` 能执行，并把 platform-tools 目录加入 PATH |
| 设备一直「未授权」 | 重新插拔 USB，点「允许 USB 调试」，必要时撤销授权后重试 |
| 小米设备能投屏但点不动 | 打开「USB 调试（安全设置）」，需要登录小米账号 |
| 密码框弹不出键盘 | 关闭厂商的「安全输入」，并确认至少启用了一个输入法 |
| 连不上 server | 宿主机执行 `curl http://<server-ip>:8080/api/health`，检查防火墙 / 安全组 |
| 提示 Key 无效 | Key 只能显示一次；在控制台「重置 Key」后用新命令重新接入 |
| 设备不出现 | 确认 `adb devices` / `ios list` 能看到设备，`doctor` 通过后再看 agent 日志 |
| `ios list` 为空 | 换 USB 线 / 口，确认 iTunes 或 Apple 设备服务已启动，手机已信任电脑 |
| WDA 刚启动就退出 | 查看是否 `lost connection to testmanagerd`，通常是 USB 掉线，重新插拔后重启 |
| `127.0.0.1:8100` 打不开 | 执行 `ios forward 8100 8100 --udid=<udid>`，或确认 server 已自动转发 |
| iOS 投屏看不到键盘 | 密码框的安全键盘会被系统从截图里抹掉，属正常，真机可见 |

---

## 12. 可选：私有 npm

不想发离线包时，可以搭 Verdaccio / GitHub Packages，把 `@adh/protocol`、`@adh/device-host`、`@adh/agent` 依次发布（先把 `workspace:*` 改成实际版本号），目标机 `npm i -g @adh/agent` 即可获得全局 `adh-agent` 命令。