package com.adh.portal

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface

/** MediaProjection → MediaCodec(H.264) → AVCC access unit。 */
class ScreenEncoder(
    private val context: Context,
    private val projection: MediaProjection,
    private val quality: String,
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        fun onConfig(config: H264.Config, width: Int, height: Int, rotation: Int)
        fun onFrame(data: ByteArray, key: Boolean)
        fun onError(message: String)
    }

    private var codec: MediaCodec? = null
    private var display: VirtualDisplay? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var config: H264.Config? = null

    @Volatile private var running = false
    private var width = 0
    private var height = 0
    private var rotation = 0

    fun start() {
        val metrics = DeviceReporter.resolution(context)
        rotation = currentRotation()
        val target = fit(metrics.first, metrics.second)
        width = target.first
        height = target.second

        val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
            setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
            )
            setInteger(MediaFormat.KEY_BIT_RATE, bitrate())
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR,
                )
            }
        }

        val encoder = MediaCodec.createEncoderByType(MIME)
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val input: Surface = encoder.createInputSurface()
        encoder.start()
        codec = encoder

        thread = HandlerThread("adh-encoder").also { it.start() }
        handler = Handler(thread!!.looper)
        display = projection.createVirtualDisplay(
            "adh-screen",
            width,
            height,
            context.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            input,
            null,
            handler,
        )

        running = true
        handler?.post { drain() }
    }

    fun stop() {
        running = false
        runCatching { display?.release() }
        display = null
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        thread?.quitSafely()
        thread = null
        handler = null
        config = null
    }

    fun requestKeyFrame() {
        val encoder = codec ?: return
        val params = Bundle().apply {
            putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
        }
        runCatching { encoder.setParameters(params) }
    }

    private fun drain() {
        val encoder = codec ?: return
        val info = MediaCodec.BufferInfo()
        while (running) {
            val index = try {
                encoder.dequeueOutputBuffer(info, 10_000)
            } catch (_: IllegalStateException) {
                break
            }
            when {
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val output = encoder.outputFormat
                    val sps = output.getByteBuffer("csd-0")?.let { H264.bytesOf(it) }
                    val pps = output.getByteBuffer("csd-1")?.let { H264.bytesOf(it) }
                    if (sps != null && pps != null) {
                        val cfg = H264.buildConfig(
                            listOf(H264.splitNals(sps).firstOrNull() ?: sps, H264.splitNals(pps).firstOrNull() ?: pps),
                        )
                        if (cfg != null) {
                            config = cfg
                            callbacks.onConfig(cfg, width, height, rotation)
                        }
                    }
                }
                index >= 0 -> {
                    val buffer = encoder.getOutputBuffer(index)
                    if (buffer != null && info.size > 0) {
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        val bytes = H264.bytesOf(buffer)
                        val nals = H264.splitNals(bytes)
                        if (config == null) {
                            val cfg = H264.buildConfig(nals)
                            if (cfg != null) {
                                config = cfg
                                callbacks.onConfig(cfg, width, height, rotation)
                            }
                        }
                        val current = config
                        if (current != null && nals.isNotEmpty()) {
                            val key = H264.isKeyFrame(nals)
                            // viewer 侧按 Annex-B 解析后再转 AVCC，这里必须发原始 Annex-B
                            callbacks.onFrame(bytes, key)
                        }
                    }
                    encoder.releaseOutputBuffer(index, false)
                }
            }
        }
    }

    private fun fit(rawWidth: Int, rawHeight: Int): Pair<Int, Int> {
        val maxSize = when (quality) {
            "low" -> 720
            "high" -> 1440
            "ultra" -> 0
            else -> 1080
        }
        if (maxSize <= 0) return even(rawWidth) to even(rawHeight)
        val longSide = maxOf(rawWidth, rawHeight)
        if (longSide <= maxSize) return even(rawWidth) to even(rawHeight)
        val scale = maxSize.toDouble() / longSide
        return even((rawWidth * scale).toInt()) to even((rawHeight * scale).toInt())
    }

    private fun even(value: Int): Int = if (value % 2 == 0) value else value - 1

    private fun bitrate(): Int = when (quality) {
        "low" -> 2_000_000
        "high" -> 8_000_000
        "ultra" -> 12_000_000
        else -> 4_000_000
    }

    fun currentRotation(): Int {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        return manager.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation ?: 0
    }

    companion object {
        private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
    }
}