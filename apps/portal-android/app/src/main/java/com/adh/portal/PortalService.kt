package com.adh.portal

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.net.wifi.WifiManager
import android.net.wifi.WifiInfo
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.IBinder
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PortalService : Service(), AgentClient.Listener {
    private var agent: AgentClient? = null
    private var stream: StreamClient? = null
    private val http = OkHttpClient()
    private val io = Executors.newCachedThreadPool()
    private val thumbnailTimer = android.os.Handler(android.os.Looper.getMainLooper())
    private var lastThumbAt = 0L
    private var lastStatus = ""

    override fun onCreate() {
        super.onCreate()
        Config.init(this)
        createChannel()
        ensureForeground(false)
        FrameStats.start()
        KeepAlive.onServiceStarted(this)
        // 系统停止共享（用户点「停止共享」/ 被系统撤销）时立即断开，别让控制台继续显示在线
        ProjectionController.onStopped = {
            PortalState.connected = false
            PortalState.status = "共享屏幕已停止"
            stream?.stop("共享屏幕已停止")
            stream = null
            agent?.stop()
            agent = null
            updateNotification(StatusText.PROJECTION_STOPPED)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                // 用户主动停止：撤掉保活，避免刚停就被拉起来
                Config.userStopped = true
                PortalState.connected = false
                KeepAlive.onServiceStopped(this)
                stopEverything()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_PROJECTION -> {
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val data = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                ProjectionController.setConsent(code, data)
                // 只记授权，不在这里声明 mediaProjection 前台类型：
                // 拿不到投屏数据前就声明，Android 14+ 会在超时后直接杀进程
                ensureForeground(false)
                PortalState.status = "正在连接…"
                PortalState.append("投屏已授权")
                startAgent()
            }
            else -> startAgent()
        }
        return START_STICKY
    }

    private fun startAgent() {
        if (!Config.configured) {
            updateNotification(StatusText.NOT_CONFIGURED)
            PortalState.status = "未配置 server 地址"
            return
        }
        // 没有投屏授权就不连：否则控制台显示「已连接」，但打开控制看不到画面
        if (!ProjectionController.hasConsent) {
            PortalState.connected = false
            PortalState.status = "未授权共享屏幕"
            updateNotification(StatusText.NO_PROJECTION)
            return
        }
        if (agent != null) return
        val client = AgentClient(this)
        agent = client
        client.start()
        scheduleThumbnail()
    }

    override fun onConnected() {
        PortalState.connected = true
        try {
            updateNotification(StatusText.CONNECTED)
            PortalState.append("已连接 ${Config.serverUrl}")
            val client = agent ?: return
            val info = DeviceReporter.info(this)
            android.util.Log.i("ADH", "devices.sync ${info}")
            client.send(Protocol.devicesSync(info))
            uploadThumbnail(true)
        } catch (error: Exception) {
            android.util.Log.e("ADH", "onConnected failed", error)
            PortalState.append("同步设备信息失败：${error.message}")
            updateNotification(StatusText.SYNC_FAILED)
        }
    }

    override fun onDisconnected(reason: String) {
        PortalState.connected = false
        PortalState.append("连接中断：$reason")
        updateNotification(StatusText.reconnecting(reason))
    }

    override fun onStopped(reason: String) {
        PortalState.connected = false
        PortalState.append("连接已结束：$reason")
        updateNotification(StatusText.stopped(reason))
        stream?.stop(reason)
        stream = null
        agent = null
        if (reason.contains("invalid key") || reason.contains("replaced")) {
            stopSelf()
        }
    }

    override fun onCommand(id: String, action: String, params: JSONObject) {
        when (action) {
            "screen.start" -> startStream(id, params)
            "screen.stop" -> {
                stream?.stop("控制台关闭投屏")
                stream = null
                reply(id, true)
            }
            "screenshot" -> io.execute { captureScreenshot(id) }
            "input.text" -> {
                val text = params.optString("text")
                val ok = text.isNotEmpty() && A11yBridge.setText(text)
                reply(id, ok, error = if (ok) null else "输入失败：请启用无障碍或 ADH 输入法")
            }
            "input.key" -> {
                val key = params.optString("key")
                val ok = when (key) {
                    "home" -> A11yBridge.home()
                    "back" -> A11yBridge.back()
                    "recent" -> A11yBridge.recents()
                    "volumeUp" -> DeviceControl.volume(this, true) == null
                    "volumeDown" -> DeviceControl.volume(this, false) == null
                    "mute" -> DeviceControl.mute(this) == null
                    "power" -> DeviceControl.lock(this) == null
                    else -> false
                }
                reply(id, ok, error = if (ok) null else "不支持的按键：$key")
            }
            "app.launch" -> io.execute { launchApp(id, params.optString("package")) }
            "app.list" -> io.execute { listApps(id) }
            "app.install" -> io.execute { installApp(id, params.optString("url")) }
            "app.uninstall" -> io.execute { uninstallApp(id, params.optString("package")) }
            "gallery.import" -> io.execute { importGallery(id, params) }
            "battery" -> io.execute { reply(id, true, JSONObject().put("battery", batteryStats())) }
            "runtime" -> io.execute { reply(id, true, runtimeStats()) }
            "perf" -> io.execute { reply(id, true, perfStats()) }
            "device.reboot", "shell", "logcat.start", "logcat.stop" ->
                reply(id, false, error = "直连模式不支持该操作，请使用带宿主机 Agent 的节点")
            else -> reply(id, false, error = "不支持的操作：$action")
        }
    }

    private fun startStream(id: String, params: JSONObject) {
        if (!ProjectionController.hasConsent) {
            reply(id, false, error = "未授权屏幕录制，请打开 ADH 直连 App 完成投屏授权")
            return
        }
        val sessionId = params.optString("sessionId")
        if (sessionId.isBlank()) {
            reply(id, false, error = "缺少 sessionId")
            return
        }
        if (stream != null) {
            reply(id, true)
            return
        }
        // Android 14+：必须先声明 mediaProjection 前台类型，紧接着调用 getMediaProjection，
        // 中间不能等（声明后迟迟不取投屏数据会被系统判为违规）。
        ensureForeground(true)
        val projection = ProjectionController.ensure(this)
        if (projection == null) {
            ensureForeground(false)
            reply(id, false, error = "投屏授权已失效，请在 App 里重新授权「共享屏幕」")
            return
        }
        val client = StreamClient(this, sessionId, params.optString("quality", "medium")) { reason ->
            stream = null
            // 控制台退出是常态，别提示成「投屏已结束」，让用户以为要重新授权
            updateNotification(
                if (reason.isNullOrBlank() || reason.contains("控制台")) {
                    StatusText.STANDBY
                } else {
                    StatusText.streamEnded(reason)
                },
            )
        }
        stream = client
        client.start()
        reply(id, true)
    }

    private fun captureScreenshot(id: String) {
        val bitmap = A11yBridge.screenshot() ?: if (stream == null) ProjectionController.capture(this) else null
        if (bitmap == null) {
            android.util.Log.w(
                "ADH",
                "screenshot failed projection=${ProjectionController.hasConsent} a11y=${A11yBridge.ready}",
            )
            reply(id, false, error = "截图失败：请确认已授权投屏或启用无障碍")
            return
        }
        val jpeg = encodeJpeg(bitmap, 1280, 85)
        bitmap.recycle()
        reply(
            id,
            true,
            JSONObject().apply {
                put("base64", Base64.encodeToString(jpeg, Base64.NO_WRAP))
                put("width", DeviceReporter.resolution(this@PortalService).first)
                put("height", DeviceReporter.resolution(this@PortalService).second)
            },
        )
    }

    private fun launchApp(id: String, packageName: String) {
        if (packageName.isBlank()) {
            reply(id, false, error = "缺少 package")
            return
        }
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        if (intent == null) {
            reply(id, false, error = "未安装或没有启动入口：$packageName")
            return
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        runCatching { startActivity(intent) }
            .onSuccess { reply(id, true) }
            .onFailure { reply(id, false, error = it.message ?: "启动失败") }
    }

    private fun listApps(id: String) {
        val packages = JSONArray()
        val manager = packageManager
        val flags = PackageManager.GET_META_DATA
        for (info in manager.getInstalledPackages(flags)) {
            if (info.packageName == packageName) continue
            packages.put(
                JSONObject().apply {
                    put("name", info.packageName)
                    put("label", manager.getApplicationLabel(info.applicationInfo).toString())
                    put("version", info.versionName ?: "")
                    put("size", File(info.applicationInfo.sourceDir).length())
                },
            )
        }
        reply(id, true, JSONObject().put("packages", packages))
    }

    /**
     * 服务端下发的安装包地址如果指向 127.0.0.1 / localhost，
     * 说明它没拿到局域网 IP，这里用 App 自己连的 server 地址替换。
     */
    private fun normalizeDownloadUrl(raw: String): String {
        return try {
            val uri = java.net.URI(raw)
            val host = uri.host
            if (host == null || (host != "127.0.0.1" && host != "localhost" && host != "::1")) {
                return raw
            }
            val server = java.net.URI(Config.baseUrl())
            val serverHost = server.host ?: return raw
            val port = if (server.port > 0) ":${server.port}" else ""
            val query = uri.rawQuery?.let { "?$it" } ?: ""
            "${uri.scheme}://$serverHost$port${uri.rawPath}$query"
        } catch (_: Exception) {
            raw
        }
    }

    private fun installApp(id: String, url: String) {
        if (url.isBlank()) {
            reply(id, false, error = "缺少安装包地址")
            return
        }
        val downloadUrl = normalizeDownloadUrl(url)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            reply(
                id,
                false,
                error = "未授予「安装未知应用」权限。请在 App 的授权状态里开启；" +
                    "vivo / iQOO 还需要在应用信息右上角 ⋮ 里「解除限制」",
            )
            return
        }
        val file = File(cacheDir, "install-${System.currentTimeMillis()}.apk")
        try {
            http.newCall(
                Request.Builder()
                    .url(downloadUrl)
                    .header("authorization", "Bearer ${Config.authToken}")
                    .build(),
            ).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) {
                    reply(id, false, error = "下载安装包失败：HTTP ${response.code}")
                    return
                }
                file.outputStream().use { out -> body.byteStream().copyTo(out) }
            }
            val result = installApk(file)
            reply(id, result.first, error = result.second.ifBlank { null })
        } catch (error: Exception) {
            reply(id, false, error = error.message ?: "安装失败")
        } finally {
            file.delete()
        }
    }

    /** PackageInstaller 必须由用户在设备上确认；等待系统广播直到成功/失败。 */
    private fun installApk(file: File): Pair<Boolean, String> {
        val installer = packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setSize(file.length())
        val sessionId = installer.createSession(params)
        val action = "$packageName.INSTALL_RESULT"
        val latch = CountDownLatch(1)
        var success = false
        var message = "安装超时"

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        val confirm = if (Build.VERSION.SDK_INT >= 33) {
                            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                        } else {
                            @Suppress("DEPRECATION")
                            intent.getParcelableExtra(Intent.EXTRA_INTENT)
                        }
                        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        if (confirm != null) startActivity(confirm)
                    }
                    PackageInstaller.STATUS_SUCCESS -> {
                        success = true
                        message = ""
                        latch.countDown()
                    }
                    else -> {
                        message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                            ?: "安装失败（状态 $status）"
                        latch.countDown()
                    }
                }
            }
        }

        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(receiver, filter)
        }

        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    file.inputStream().use { input -> input.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(action).setPackage(packageName)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getBroadcast(this, sessionId, intent, flags)
                session.commit(pending.intentSender)
            }
            latch.await(180, TimeUnit.SECONDS)
        } catch (error: Exception) {
            return false to (error.message ?: "安装失败")
        } finally {
            runCatching { unregisterReceiver(receiver) }
        }
        return success to message
    }

    private fun uninstallApp(id: String, packageName: String) {
        if (packageName.isBlank()) {
            reply(id, false, error = "缺少 package")
            return
        }
        val intent = Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { startActivity(intent) }
            .onSuccess { reply(id, true) }
            .onFailure { reply(id, false, error = it.message ?: "卸载失败") }
    }

    private fun importGallery(id: String, params: JSONObject) {
        val data = params.optString("data")
        val name = params.optString("name", "adh-${System.currentTimeMillis()}.png")
        if (data.isBlank()) {
            reply(id, false, error = "缺少图片内容")
            return
        }
        val bytes = Base64.decode(data, Base64.DEFAULT)
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        if (bitmap == null) {
            reply(id, false, error = "图片解码失败")
            return
        }
        val saved = saveToGallery(bitmap, name)
        bitmap.recycle()
        if (saved == null) {
            reply(id, false, error = "写入相册失败")
        } else {
            reply(id, true, JSONObject().put("path", saved).put("name", name))
        }
    }

    private fun saveToGallery(bitmap: Bitmap, name: String): String? {
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = android.content.ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/png")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ADH")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    ?: return null
                contentResolver.openOutputStream(uri)?.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                values.clear()
                values.put(MediaStore.Images.Media.IS_PENDING, 0)
                contentResolver.update(uri, values, null, null)
                uri.toString()
            } else {
                val dir = File(
                    android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_PICTURES,
                    ),
                    "ADH",
                ).apply { mkdirs() }
                val file = File(dir, name)
                file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                android.media.MediaScannerConnection.scanFile(
                    this,
                    arrayOf(file.absolutePath),
                    arrayOf("image/png"),
                    null,
                )
                file.absolutePath
            }
        }.getOrNull()
    }

    private fun scheduleThumbnail() {
        thumbnailTimer.postDelayed(
            object : Runnable {
                override fun run() {
                    uploadThumbnail(false)
                    thumbnailTimer.postDelayed(this, 60_000)
                }
            },
            60_000,
        )
    }

    private fun uploadThumbnail(force: Boolean) {
        if (!force && SystemClock.elapsedRealtime() - lastThumbAt < 30_000) return
        io.execute {
            val bitmap = A11yBridge.screenshot() ?: ProjectionController.capture(this) ?: return@execute
            val jpeg = encodeJpeg(bitmap, 360, 78)
            bitmap.recycle()
            lastThumbAt = SystemClock.elapsedRealtime()
            val request = Request.Builder()
                .url("${Config.baseUrl()}/api/agent/devices/${Config.deviceId}/thumbnail")
                .header("authorization", "Bearer ${Config.authToken}")
                .put(jpeg.toRequestBody("image/jpeg".toMediaType()))
                .build()
            runCatching { http.newCall(request).execute().close() }
        }
    }

    private fun batteryStats(): JSONObject {
        val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val temperature = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
            ?: Int.MIN_VALUE
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL || plugged != 0
        val state = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
            BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
            BatteryManager.BATTERY_STATUS_FULL -> "full"
            BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
            else -> "unknown"
        }
        return JSONObject().apply {
            if (level >= 0 && scale > 0) put("level", level * 100 / scale)
            else put("level", JSONObject.NULL)
            put("charging", charging)
            put("status", state)
            if (temperature != Int.MIN_VALUE) put("temperature", temperature / 10.0)
            else put("temperature", JSONObject.NULL)
        }
    }

    private fun runtimeStats(): JSONObject {
        val battery = batteryStats()
        val memory = JSONObject().apply {
            val manager = getSystemService(ActivityManager::class.java)
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            put("totalMb", info.totalMem / 1024 / 1024)
            put("usedMb", (info.totalMem - info.availMem) / 1024 / 1024)
        }
        val storage = JSONObject().apply {
            val stat = StatFs(Environment.getDataDirectory().path)
            val total = stat.totalBytes / 1024 / 1024
            val free = stat.availableBytes / 1024 / 1024
            put("totalMb", total)
            put("usedMb", total - free)
        }
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork
        val capabilities = network?.let { connectivity.getNetworkCapabilities(it) }
        val connected = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val wifi = getSystemService(WifiManager::class.java)
        val wifiInfo = JSONObject().apply {
            put("connected", connected)
            put("ssid", currentSsid(capabilities) ?: JSONObject.NULL)
            put("enabled", wifi.isWifiEnabled)
            put("ip", localIpv4() ?: JSONObject.NULL)
        }
        return JSONObject().apply {
            put("battery", battery)
            put("memory", memory)
            put("storage", storage)
            put("wifi", wifiInfo)
            put("uptimeSeconds", SystemClock.elapsedRealtime() / 1000)
        }
    }

    /** 控制页性能图表：CPU / 内存 / 实时帧率 / 电量 / 网络。 */
    private fun perfStats(): JSONObject {
        val manager = getSystemService(ActivityManager::class.java)
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        val battery = batteryStats()

        val netStartedAt = SystemClock.elapsedRealtime()
        val rxBefore = TrafficStats.getTotalRxBytes()
        val txBefore = TrafficStats.getTotalTxBytes()
        val cpu = cpuUsage()
        val netElapsed = (SystemClock.elapsedRealtime() - netStartedAt) / 1000.0
        val rxAfter = TrafficStats.getTotalRxBytes()
        val txAfter = TrafficStats.getTotalTxBytes()

        val refreshRate = getSystemService(android.hardware.display.DisplayManager::class.java)
            .getDisplay(android.view.Display.DEFAULT_DISPLAY)
            ?.refreshRate

        return JSONObject().apply {
            put("ts", System.currentTimeMillis())
            if (cpu == null) put("cpu", JSONObject.NULL) else put("cpu", cpu)
            put("memoryUsedMb", (info.totalMem - info.availMem) / 1024 / 1024)
            put("memoryTotalMb", info.totalMem / 1024 / 1024)
            put("fps", Math.round(FrameStats.fps() * 10.0) / 10.0)
            if (refreshRate == null) put("refreshRate", JSONObject.NULL)
            else put("refreshRate", Math.round(refreshRate * 10.0) / 10.0)

            if (battery.isNull("level")) put("batteryLevel", JSONObject.NULL)
            else put("batteryLevel", battery.optInt("level"))
            if (battery.isNull("temperature")) put("batteryTemperature", JSONObject.NULL)
            else put("batteryTemperature", battery.optDouble("temperature"))

            put("networkRxKbps", netKbps(rxBefore, rxAfter, netElapsed))
            put("networkTxKbps", netKbps(txBefore, txAfter, netElapsed))
        }
    }

    /** TrafficStats 返回累计字节数，取差值换算成 KB/s。 */
    private fun netKbps(before: Long, after: Long, elapsedSec: Double): Any {
        if (before < 0 || after < 0 || after < before || elapsedSec <= 0) return JSONObject.NULL
        return Math.round((after - before) / 1024.0 / elapsedSec * 10.0) / 10.0
    }

    /** 两次读取 /proc/stat 取差值，算出整机 CPU 占用。 */
    private fun cpuUsage(): Double? {
        val before = readProcStat() ?: return null
        Thread.sleep(300)
        val after = readProcStat() ?: return null
        val total = after.first - before.first
        val idle = after.second - before.second
        if (total <= 0) return null
        val percent = (total - idle) * 100.0 / total
        return Math.round(percent.coerceIn(0.0, 100.0) * 10.0) / 10.0
    }

    /** 返回 (总时间, 空闲时间)。 */
    private fun readProcStat(): Pair<Long, Long>? {
        return runCatching {
            val line = File("/proc/stat")
                .readLines()
                .firstOrNull { it.startsWith("cpu ") } ?: return@runCatching null
            val parts = line.trim()
                .split(Regex("\\s+"))
                .drop(1)
                .map { it.toLong() }
            if (parts.size < 4) return@runCatching null
            val idle = parts[3] + (parts.getOrNull(4) ?: 0L)
            val total = parts.take(8).sum()
            total to idle
        }.getOrNull()
    }

    /**
     * 当前 WiFi 名称。Android 10+ 需要定位权限（Android 13+ 用 NEARBY_WIFI_DEVICES），
     * 并且系统定位开关要打开，否则系统只会返回 <unknown ssid>。
     */
    private fun currentSsid(capabilities: NetworkCapabilities?): String? {
        return try {
            if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) != true) return null
            val info = capabilities.transportInfo as? WifiInfo ?: return null
            val ssid = info.ssid?.trim('"')?.trim()
            if (ssid.isNullOrBlank() || ssid == "<unknown ssid>" || ssid == "0x") null else ssid
        } catch (_: Exception) {
            null
        }
    }

    private fun localIpv4(): String? {
        return try {
            val networks = NetworkInterface.getNetworkInterfaces()
            while (networks.hasMoreElements()) {
                val network = networks.nextElement()
                val addresses = network.inetAddresses
                while (addresses.hasMoreElements()) {
                    val address = addresses.nextElement()
                    if (!address.isLoopbackAddress && address is Inet4Address) {
                        return address.hostAddress
                    }
                }
            }
            null
        } catch (_: Exception) {
            null
        }
    }

    private fun encodeJpeg(bitmap: Bitmap, maxWidth: Int, quality: Int): ByteArray {
        val scale = minOf(1f, maxWidth.toFloat() / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) {
            Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * scale).toInt().coerceAtLeast(1),
                (bitmap.height * scale).toInt().coerceAtLeast(1),
                true,
            )
        } else {
            bitmap
        }
        return ByteArrayOutputStream().use {
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, it)
            it.toByteArray()
        }
    }

    private fun reply(id: String, ok: Boolean, data: Any? = null, error: String? = null) {
        agent?.send(Protocol.cmdResult(id, ok, data, error))
        // 指令失败只写日志：通知栏是给用户看连接状态的，不该被技术报错刷屏
        if (!ok && !error.isNullOrBlank()) PortalState.append("指令失败：$error")
    }

    private fun ensureForeground(withProjection: Boolean) {
        val notification = buildNotification(lastStatus.ifBlank { StatusText.CONNECTING })
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 只能在真正要建立投屏的那一刻带上 mediaProjection 类型：
            // Android 14+ 声明了该类型后若迟迟不调用 getMediaProjection()，系统会直接抛异常。
            val type = if (withProjection) {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            } else {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            startForeground(NOTIFICATION_ID, notification, type)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "设备连接状态",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "显示设备与控制台的连接情况，静默常驻，不会响铃"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(StatusText.TITLE)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_stat_adh)
            .setLargeIcon(
                android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_brand_round),
            )
            .setContentIntent(intent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
    }

    private fun updateNotification(text: String) {
        lastStatus = text
        PortalState.status = text
        PortalState.append(text)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun stopEverything() {
        PortalState.connected = false
        agent?.stop()
        agent = null
        stream?.stop("服务已停止")
        stream = null
        thumbnailTimer.removeCallbacksAndMessages(null)
        FrameStats.stop()
        ProjectionController.release()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 从最近任务划掉不算停止：服务继续上报，被系统回收时由 KeepAlive 拉回来。
        // 只有 App 内点「断开」才会真正停止（见 ACTION_STOP）。
        KeepAlive.scheduleRestart(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "adh_portal"
        private const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.adh.portal.START"
        const val ACTION_STOP = "com.adh.portal.STOP"
        const val ACTION_PROJECTION = "com.adh.portal.PROJECTION"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        fun start(context: Context) {
            val intent = Intent(context, PortalService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Android 12+ 后台启动前台服务可能被拒，交给下一轮 Job/Alarm 再试
                runCatching { context.startForegroundService(intent) }
            } else {
                runCatching { context.startService(intent) }
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, PortalService::class.java).setAction(ACTION_STOP))
        }

        fun projectionGranted(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, PortalService::class.java)
                .setAction(ACTION_PROJECTION)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}











