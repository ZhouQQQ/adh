package com.adh.portal

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.DisplayMetrics

/**
 * 持有用户授权的 MediaProjection。
 *
 * Android 14 要求授权后由前台服务调用 getMediaProjection，并且每次进程重启都要重新授权，
 * 因此这里只缓存 consent，进程内复用同一个 MediaProjection 实例。
 */
object ProjectionController {
    private var resultCode: Int = Activity.RESULT_CANCELED
    private var consent: Intent? = null
    private var projection: MediaProjection? = null
    private var callback: MediaProjection.Callback? = null

    /** 系统停止共享（用户点「停止共享」/ 被系统撤销）时回调，用来把连接一起断掉。 */
    @Volatile
    var onStopped: (() -> Unit)? = null

    fun setConsent(code: Int, data: Intent?) {
        release()
        resultCode = code
        consent = data
    }

    /**
     * 是否有可用的共享屏幕授权。
     * 注意：MediaProjection 被系统停止后同一个令牌就失效了，
     * 这里会连同 consent 一起清掉，避免 UI 一直显示「已授权」但实际没在共享。
     */
    val hasConsent: Boolean
        get() = consent != null && resultCode == Activity.RESULT_OK

    private fun clearConsent() {
        resultCode = Activity.RESULT_CANCELED
        consent = null
    }

    fun ensure(context: Context): MediaProjection? {
        projection?.let { return it }
        val data = consent ?: return null
        if (resultCode != Activity.RESULT_OK) return null
        val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val created = try {
            manager.getMediaProjection(resultCode, data)
        } catch (error: Exception) {
            // Android 14+ 一次授权只能创建一次 MediaProjection；
            // 令牌失效（服务重建 / 类型不对 / 已被系统回收）时清掉，强制重新授权
            android.util.Log.w("ADH", "getMediaProjection failed", error)
            clearConsent()
            return null
        }
        if (created == null) {
            clearConsent()
            return null
        }
        val cb = object : MediaProjection.Callback() {
            override fun onStop() {
                if (projection === created) {
                    projection = null
                    callback = null
                }
                // 停止后令牌不可复用，必须重新授权
                clearConsent()
                onStopped?.invoke()
            }
        }
        created.registerCallback(cb, Handler(Looper.getMainLooper()))
        projection = created
        callback = cb
        return created
    }

    fun release() {
        val current = projection
        val cb = callback
        if (current != null && cb != null) runCatching { current.unregisterCallback(cb) }
        runCatching { current?.stop() }
        projection = null
        callback = null
        // projection 停止后令牌就作废了，一起清掉，避免 UI 误显示「已授权」
        clearConsent()
    }

    /** 用 ImageReader 抓一帧；和编码器同时使用时可能失败，失败返回 null。 */
    fun capture(context: Context): Bitmap? {
        val mp = ensure(context) ?: return null
        val (width, height) = DeviceReporter.resolution(context)
        val metrics = context.resources.displayMetrics
        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        var display: VirtualDisplay? = null
        val thread = HandlerThread("adh-capture").also { it.start() }
        val handler = Handler(thread.looper)
        try {
            display = mp.createVirtualDisplay(
                "adh-capture",
                width,
                height,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface,
                null,
                handler,
            )
            var image = reader.acquireLatestImage()
            var waited = 0
            while (image == null && waited < 1200) {
                Thread.sleep(40)
                waited += 40
                image = reader.acquireLatestImage()
            }
            val frame = image ?: return null
            return try {
                val plane = frame.planes[0]
                val rowStride = plane.rowStride
                val pixelStride = plane.pixelStride
                val rowPadding = rowStride - pixelStride * width
                val padded = Bitmap.createBitmap(
                    width + rowPadding / pixelStride,
                    height,
                    Bitmap.Config.ARGB_8888,
                )
                padded.copyPixelsFromBuffer(plane.buffer)
                Bitmap.createBitmap(padded, 0, 0, width, height)
            } finally {
                frame.close()
            }
        } catch (error: Exception) {
            android.util.Log.w("ADH", "projection capture failed", error)
            return null
        } finally {
            display?.release()
            reader.close()
            thread.quitSafely()
        }
    }
}



