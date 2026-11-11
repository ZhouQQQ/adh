package com.adh.portal

import android.os.SystemClock
import android.view.Choreographer

/**
 * 统计最近 1 秒绘制了多少帧，作为「实时帧率」。
 *
 * Choreographer 仍然由系统 VSYNC 驱动，和 SurfaceFlinger 统计的是同一批帧；
 * 屏幕熄灭 / 完全静止时没有新帧，返回值会降到 0。
 */
object FrameStats {
    private val timestamps = ArrayDeque<Long>()
    private var callback: Choreographer.FrameCallback? = null

    fun start() {
        if (callback != null) return
        val dispatcher = Choreographer.getInstance()
        val frameCallback = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                synchronized(timestamps) {
                    timestamps.addLast(frameTimeNanos)
                    val cutoff = frameTimeNanos - 1_000_000_000L
                    while (timestamps.isNotEmpty() && timestamps.first() < cutoff) {
                        timestamps.removeFirst()
                    }
                    while (timestamps.size > 256) timestamps.removeFirst()
                }
                dispatcher.postFrameCallback(this)
            }
        }
        callback = frameCallback
        dispatcher.postFrameCallback(frameCallback)
    }

    fun stop() {
        val current = callback ?: return
        callback = null
        runCatching { Choreographer.getInstance().removeFrameCallback(current) }
        synchronized(timestamps) { timestamps.clear() }
    }

    /** 最近 1 秒内的帧数。 */
    fun fps(): Double {
        synchronized(timestamps) {
            if (timestamps.isEmpty()) return 0.0
            val cutoff = SystemClock.elapsedRealtimeNanos() - 1_000_000_000L
            return timestamps.count { it >= cutoff }.toDouble()
        }
    }
}
