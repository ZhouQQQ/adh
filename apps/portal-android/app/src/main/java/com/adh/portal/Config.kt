package com.adh.portal

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import java.util.UUID

/** 本地持久化：服务器地址、agent key、显示名、稳定的设备 ID。 */
object Config {
    private const val FILE = "adh_portal"
    private lateinit var prefs: SharedPreferences
    private lateinit var appContext: Context

    fun init(context: Context) {
        if (!::prefs.isInitialized) {
            appContext = context.applicationContext
            prefs = appContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        }
        // 127.0.0.1 只指向手机自己，历史上用于 adb reverse 调试，正式环境一律清掉
        val saved = prefs.getString("server", "") ?: ""
        if (saved.startsWith("ws://127.0.0.1") || saved.startsWith("ws://localhost") ||
            saved.startsWith("wss://127.0.0.1")
        ) {
            prefs.edit().remove("server").remove("key").remove("agentToken").apply()
        }
    }

    var serverUrl: String
        get() = prefs.getString("server", "") ?: ""
        set(value) = prefs.edit().putString("server", normalize(value)).apply()

    var key: String
        get() = prefs.getString("key", "") ?: ""
        set(value) = prefs.edit().putString("key", value.trim()).apply()

    /** server 在 welcome 里下发的本设备内部 token，用于流与上传。 */
    var agentToken: String
        get() = prefs.getString("agentToken", "") ?: ""
        set(value) = prefs.edit().putString("agentToken", value.trim()).apply()

    val authToken: String
        get() = agentToken.ifBlank { key }

    var displayName: String
        get() = prefs.getString("name", "") ?: ""
        set(value) = prefs.edit().putString("name", value.trim()).apply()

    var autoStart: Boolean
        get() = prefs.getBoolean("autoStart", true)
        set(value) = prefs.edit().putBoolean("autoStart", value).apply()

    /**
     * 用户主动停止（App 内点断开，或从最近任务里划掉）。
     * 为 true 时后台保活不会再把服务拉起来，直到用户重新打开 App。
     */
    var userStopped: Boolean
        get() = prefs.getBoolean("userStopped", false)
        set(value) = prefs.edit().putBoolean("userStopped", value).apply()

    /**
     * 用户是否已经点过「前往设置」配置自启动。
     * 厂商 ROM 的自启动开关没有公开 API 可查，只能按「用户确认」记录。
     */
    var autoStartConfirmed: Boolean
        get() = prefs.getBoolean("autoStartConfirmed", false)
        set(value) = prefs.edit().putBoolean("autoStartConfirmed", value).apply()

    val configured: Boolean
        get() = serverUrl.isNotBlank() && key.isNotBlank()

    /**
     * 设备 UDID：优先取系统 ro.serialno / ro.boot.serialno，和 USB adb 的序列号一致；
     * Android 10+ 普通应用读不到硬件序列号，会退回 ANDROID_ID（此时必然和 USB 序列号不同，属于系统限制）。
     * 设备有 root 时用 su 直接读 ro.serialno，就能和 USB 保持一致。
     */
    val deviceId: String
        get() {
            val serial = SystemProps.get("ro.serialno")
                ?.takeIf { it.isNotBlank() && !it.equals("unknown", ignoreCase = true) }
                ?: SystemProps.get("ro.boot.serialno")
                    ?.takeIf { it.isNotBlank() && !it.equals("unknown", ignoreCase = true) }
            val androidId = Settings.Secure.getString(
                appContext.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
            val buildSerial = if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                appContext.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            ) {
                runCatching { Build.getSerial() }.getOrNull()
                    ?.takeIf { it.isNotBlank() && !it.equals("unknown", ignoreCase = true) }
            } else {
                null
            }
            // root 读取结果缓存起来，避免每次上报都 fork 一次 su
            val rootSerial = serial ?: buildSerial ?: cachedRootSerial() ?: readRootSerial()?.also {
                prefs.edit().putString("rootSerial", it).apply()
            }
            val real = rootSerial ?: androidId
            val existing = prefs.getString("deviceId", null)
            if (!real.isNullOrBlank()) {
                if (existing != real) prefs.edit().putString("deviceId", real).apply()
                return real
            }
            if (existing != null) return existing
            val id = UUID.randomUUID().toString()
            prefs.edit().putString("deviceId", id).apply()
            return id
        }

    private fun cachedRootSerial(): String? =
        prefs.getString("rootSerial", null)
            ?.takeIf { it.isNotBlank() && !it.equals("unknown", ignoreCase = true) }

    /**
     * Agent 行的稳定标识。设备 UDID 可能因为拿到真实序列号而变，
     * 但 instanceId 必须稳定，否则 server 会不断新建 agent 行。
     */
    val instanceId: String
        get() = prefs.getString("instanceId", null) ?: run {
            val androidId = Settings.Secure.getString(
                appContext.contentResolver,
                Settings.Secure.ANDROID_ID,
            )
            val id = androidId?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
            prefs.edit().putString("instanceId", id).apply()
            id
        }

    /** 有 root 时读硬件序列号；没有 root / 用户拒绝会很快返回 null。 */
    private fun readRootSerial(): String? {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", "getprop ro.serialno"))
            val value = process.inputStream.bufferedReader().use { it.readText() }.trim()
            if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroy()
                return null
            }
            value.takeIf { it.isNotBlank() && !it.equals("unknown", ignoreCase = true) }
        } catch (_: Exception) {
            null
        }
    }

    /** 接受 1.2.3.4:8080 / http://... / https://...，统一成 ws(s)。 */
    fun normalize(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return ""
        if (value.startsWith("https://")) {
            value = "wss://" + value.removePrefix("https://")
        } else if (value.startsWith("http://")) {
            value = "ws://" + value.removePrefix("http://")
        } else if (!value.startsWith("ws://") && !value.startsWith("wss://")) {
            value = "ws://$value"
        }
        return value.trimEnd('/')
    }

    /** 清空已保存的地址和 Key（未连接时才能调用）。 */
    fun clearAddress() {
        prefs.edit().remove("server").remove("key").remove("agentToken").apply()
    }

    fun baseUrl(): String = serverUrl.replaceFirst("^ws://", "http://").replaceFirst("^wss://", "https://")
    /** UI 只展示一个地址：ws://host:8080?key=adh_xxx */
    val address: String
        get() {
            if (serverUrl.isBlank()) return ""
            if (key.isBlank()) return serverUrl
            return "$serverUrl?key=$key"
        }

    /**
     * 解析平台生成的连接地址。支持 ws://、http://、裸 host:port，key 放在 ?key= 里。
     * 返回 false 表示格式不合法。
     */
    fun setAddress(raw: String): Boolean {
        var value = raw.trim()
        if (value.isEmpty()) return false
        if (value.startsWith("adh://")) {
            // adh://pair?server=...&key=...
            val query = value.substringAfter('?', "")
            val server = query.split('&').firstOrNull { it.startsWith("server=") }?.substringAfter('=')
            val pairKey = query.split('&').firstOrNull { it.startsWith("key=") }?.substringAfter('=')
            if (server.isNullOrBlank()) return false
            serverUrl = server
            if (!pairKey.isNullOrBlank()) key = pairKey
            return configured
        }
        if (!value.contains("://")) value = "ws://$value"
        val uri = android.net.Uri.parse(value)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "ws" && scheme != "wss" && scheme != "http" && scheme != "https") return false
        val host = uri.host ?: return false
        val port = if (uri.port > 0) ":${uri.port}" else ""
        val path = uri.path?.trimEnd('/') ?: ""
        val wsScheme = if (scheme == "https") "wss" else if (scheme == "http") "ws" else scheme
        serverUrl = "$wsScheme://$host$port$path"
        val pairKey = uri.getQueryParameter("key")
        if (!pairKey.isNullOrBlank()) key = pairKey
        return configured
    }
}





