package com.adh.portal

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 无障碍能力入口；未启用服务时所有操作返回 false。 */
object A11yBridge {
    @Volatile private var service: PortalAccessibilityService? = null

    val ready: Boolean get() = service != null

    fun attach(value: PortalAccessibilityService) {
        service = value
    }

    fun detach(value: PortalAccessibilityService) {
        if (service === value) service = null
    }

    fun tap(x: Float, y: Float, durationMs: Long = 60): Boolean {
        val svc = service ?: return false
        val (width, height) = screenSize(svc)
        val px = x.coerceIn(0f, 1f) * width
        val py = y.coerceIn(0f, 1f) * height
        val path = Path().apply { moveTo(px, py) }
        return dispatch(svc, path, durationMs, durationMs)
    }

    fun swipe(
        fromX: Float,
        fromY: Float,
        toX: Float,
        toY: Float,
        durationMs: Long = 300,
    ): Boolean {
        val svc = service ?: return false
        val (width, height) = screenSize(svc)
        val path = Path().apply {
            moveTo(fromX.coerceIn(0f, 1f) * width, fromY.coerceIn(0f, 1f) * height)
            lineTo(toX.coerceIn(0f, 1f) * width, toY.coerceIn(0f, 1f) * height)
        }
        return dispatch(svc, path, 0, durationMs)
    }

    private fun dispatch(svc: AccessibilityService, path: Path, start: Long, duration: Long): Boolean {
        val stroke = GestureDescription.StrokeDescription(path, start, duration.coerceAtLeast(20))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return svc.dispatchGesture(gesture, null, null)
    }

    fun globalAction(action: Int): Boolean = service?.performGlobalAction(action) ?: false

    fun back(): Boolean = globalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    fun home(): Boolean = globalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    fun recents(): Boolean = globalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)

    fun notifications(): Boolean {
        val svc = service ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        }
        return svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS)
    }

    /** 优先 ACTION_SET_TEXT；失败时交给 ADH 输入法。 */
    fun setText(text: String): Boolean {
        val svc = service
        if (svc != null) {
            val node = findEditable(svc)
            if (node != null) {
                // 很多输入框未聚焦时 ACTION_SET_TEXT 会直接返回 false，先补一次聚焦
                if (!node.isFocused) {
                    runCatching { node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) }
                    Thread.sleep(80)
                }
                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                }
                if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return true
            }
        }
        return PortalImeService.type(text)
    }

    private fun findEditable(svc: AccessibilityService): AccessibilityNodeInfo? {
        val root = svc.rootInActiveWindow ?: return null
        root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { return it }
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isEditable) return node
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { queue.add(it) }
            }
        }
        return null
    }

    /** 通过无障碍截图（Android 11+）。系统限制 333ms 内不能连续截图，失败自动重试。 */
    @Synchronized
    fun screenshot(): Bitmap? {
        val svc = service ?: return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        repeat(3) {
            val bitmap = takeScreenshotOnce(svc)
            if (bitmap != null) return bitmap
            Thread.sleep(500)
        }
        return null
    }

    private fun takeScreenshotOnce(svc: AccessibilityService): Bitmap? {
        val latch = CountDownLatch(1)
        var bitmap: Bitmap? = null
        svc.takeScreenshot(
            Display.DEFAULT_DISPLAY,
            svc.mainExecutor,
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                    val buffer = result.hardwareBuffer
                    bitmap = runCatching {
                        Bitmap.wrapHardwareBuffer(
                            buffer,
                            result.colorSpace ?: android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB),
                        )?.copy(Bitmap.Config.ARGB_8888, false)
                    }.onFailure { android.util.Log.w("ADH", "wrap screenshot failed", it) }.getOrNull()
                    buffer.close()
                    latch.countDown()
                }

                override fun onFailure(errorCode: Int) {
                    android.util.Log.w("ADH", "accessibility screenshot failed: $errorCode")
                    latch.countDown()
                }
            },
        )
        if (!latch.await(3, TimeUnit.SECONDS)) return null
        return bitmap
    }
    /** 无障碍手势使用整屏坐标（含状态栏/导航栏），不能用 resources.displayMetrics。 */
    private fun screenSize(svc: AccessibilityService): Pair<Int, Int> {
        val wm = svc.getSystemService(android.view.WindowManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        @Suppress("DEPRECATION")
        val metrics = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return metrics.widthPixels to metrics.heightPixels
    }
}




