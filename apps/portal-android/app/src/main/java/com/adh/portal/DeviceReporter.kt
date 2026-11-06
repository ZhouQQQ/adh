package com.adh.portal

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONArray
import org.json.JSONObject

/** 采集设备基础信息，字段与 DeviceInfoSchema 对齐。 */
object DeviceReporter {
    fun info(context: Context): JSONObject {
        val metrics = displayMetrics(context)
        val market = marketName()
        return JSONObject().apply {
            put("udid", Config.deviceId)
            put("platform", "android")
            // 显示名优先用市场名（如「iQOO Z10 Turbo+」），型号代码单独放 model
            put("name", market)
            put("marketName", market)
            put("model", Build.MODEL)
            put("brand", Build.MANUFACTURER)
            put("osVersion", "Android ${Build.VERSION.RELEASE}")
            put("sdk", Build.VERSION.SDK_INT)
            put("cpu", Build.HARDWARE)
            put("cpuVendor", cpuVendor())
            put("cpuModel", SystemProps.get("ro.board.platform") ?: Build.HARDWARE)
            put("cpuCode", Build.HARDWARE)
            put("cpuArch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64")
            put("cpuCores", Runtime.getRuntime().availableProcessors())
            put("memoryMb", totalMemoryMb(context))
            put("rooted", isRooted())
            put(
                "resolution",
                JSONObject().apply {
                    put("width", metrics.first)
                    put("height", metrics.second)
                },
            )
            put("status", "online")
            put(
                "capabilities",
                JSONArray().apply {
                    put("portal")
                    put("screen")
                    put("touch")
                    put("text")
                    put("apps")
                    put("gallery")
                    put("install")
                    put("rotate")
                    put("notification")
                },
            )
            put("tags", JSONArray())
        }
    }

    fun resolution(context: Context): Pair<Int, Int> = displayMetrics(context)

    private fun displayMetrics(context: Context): Pair<Int, Int> {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val width: Int
        val height: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            width = bounds.width()
            height = bounds.height()
        } else {
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
            width = metrics.widthPixels
            height = metrics.heightPixels
        }
        return width to height
    }

    private fun marketName(): String = marketNameOf()

    /** 厂商市场名，取不到才回退到型号代码。 */
    fun marketNameOf(): String {
        val props = listOf(
            "ro.vivo.market.name",
            "ro.product.marketname",
            "ro.oppo.market.name",
            "ro.config.marketing_name",
            "ro.product.model",
        )
        for (key in props) {
            val value = SystemProps.get(key)
            if (!value.isNullOrBlank()) return value
        }
        return Build.MODEL
    }

    private fun cpuVendor(): String {
        val hardware = Build.HARDWARE.lowercase()
        return when {
            hardware.startsWith("mt") || hardware.startsWith("dimensity") -> "联发科"
            hardware.startsWith("sm") || hardware.startsWith("msm") ||
                hardware.startsWith("qcom") || hardware.startsWith("sdm") -> "高通"
            hardware.startsWith("exynos") -> "三星"
            hardware.startsWith("kirin") -> "海思"
            else -> Build.MANUFACTURER
        }
    }

    private fun isRooted(): Boolean {
        val paths = listOf(
            "/system/bin/su",
            "/system/xbin/su",
            "/sbin/su",
            "/su/bin/su",
            "/data/local/bin/su",
            "/data/local/xbin/su",
        )
        if (paths.any { java.io.File(it).exists() }) return true
        return SystemProps.get("ro.build.tags")?.contains("test-keys") == true
    }

    private fun totalMemoryMb(context: Context): Long {
        val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        manager.getMemoryInfo(info)
        return info.totalMem / (1024 * 1024)
    }
}
