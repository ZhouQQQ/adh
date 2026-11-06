package com.adh.portal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import android.util.Base64
import java.util.concurrent.TimeUnit
import okio.ByteString.Companion.toByteString

/**
 * 投屏专用通道：/ws/stream/:sessionId?role=agent&token=...
 *
 * 发送 ready（含 avcC）+ 二进制 H264；接收 viewer 的 touch/key/text/panel/screen 等控制。
 */
class StreamClient(
    private val context: Context,
    private val sessionId: String,
    quality: String,
    private val onClosed: (String?) -> Unit,
) {
    @Volatile
    private var quality: String = quality
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var socket: WebSocket? = null
    @Volatile private var encoder: ScreenEncoder? = null
    @Volatile private var readySent = false
    @Volatile private var closed = false

    // 触摸轨迹：viewer 的 touch 是 began/moved/ended 序列
    private var touchStartX = 0f
    private var touchStartY = 0f
    private var touchX = 0f
    private var touchY = 0f
    private var touchDownAt = 0L
    private var touchMoved = false

    private val rotationWatch = object : Runnable {
        override fun run() {
            if (closed) return
            val current = encoder
            if (current != null) {
                val rotation = current.currentRotation()
                if (rotation != currentRotation) {
                    restartEncoder(rotation)
                }
            }
            handler.postDelayed(this, 1000)
        }
    }
    private var currentRotation = -1

    fun start() {
        val token = URLEncoder.encode(Config.authToken, "UTF-8")
        val url = Config.serverUrl + "/ws/stream/$sessionId?role=agent&token=$token"
        socket = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    startEncoder()
                    handler.postDelayed(rotationWatch, 1000)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val json = runCatching { JSONObject(text) }.getOrNull() ?: return
                    dispatch(json)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    close(reason.ifBlank { "投屏连接已关闭" })
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    close(t.message ?: "投屏网络错误")
                }
            },
        )
    }

    private fun startEncoder() {
        val projection = ProjectionController.ensure(context)
        if (projection == null) {
            sendJson(JSONObject().put("t", "error").put("message", "未授权屏幕录制，请打开 App 重新授权"))
            close("未授权屏幕录制")
            return
        }
        val created = ScreenEncoder(
            context,
            projection,
            quality,
            object : ScreenEncoder.Callbacks {
                override fun onConfig(config: H264.Config, width: Int, height: Int, rotation: Int) {
                    currentRotation = rotation
                    val payload = JSONObject().apply {
                        if (!readySent) put("t", "ready") else put("t", "rotated")
                        put("sessionId", sessionId)
                        put("platform", "android")
                        put("codec", "h264")
                        put("videoCodec", config.codec)
                        put("width", width)
                        put("height", height)
                        put("rotation", rotation)
                        put("description", Base64.encodeToString(config.description, Base64.NO_WRAP))
                    }
                    sendJson(payload)
                    readySent = true
                }

                override fun onFrame(data: ByteArray, key: Boolean) {
                    sendBinary(data)
                }

                override fun onError(message: String) {
                    sendJson(JSONObject().put("t", "error").put("message", message))
                }
            },
        )
        encoder = created
        runCatching { created.start() }
            .onFailure {
                sendJson(JSONObject().put("t", "error").put("message", it.message ?: "编码器启动失败"))
                close("编码器启动失败")
            }
    }

    private fun restartEncoder(rotation: Int) {
        val old = encoder ?: return
        old.stop()
        encoder = null
        currentRotation = rotation
        handler.postDelayed(
            {
                if (!closed) startEncoder()
            },
            400,
        )
    }

    private fun dispatch(message: JSONObject) {
        when (message.optString("t")) {
            "touch" -> handleTouch(message)
            "key" -> handleKey(message.optString("key"))
            "text" -> {
                val ok = A11yBridge.setText(message.optString("text"))
                if (!ok) {
                    sendJson(
                        JSONObject()
                            .put("t", "error")
                            .put(
                                "message",
                                "设备上没有可输入的输入框：请先在手机上点一下输入框，或启用「ADH 输入法」",
                            ),
                    )
                }
            }
            "clipboard" -> setClipboard(message.optString("text"))
            "scroll" -> handleScroll(message)
            "panel" -> if (message.optString("panel") == "notification") A11yBridge.notifications()
            "screen" -> if (message.optBoolean("on")) DeviceControl.wake(context) else DeviceControl.lock(context)
            "quality" -> {
                val next = message.optString("quality")
                if (next.isNotBlank() && next != quality) {
                    quality = next
                    // 只重启编码器，WebSocket 和投屏会话都不动
                    restartEncoder(encoder?.currentRotation() ?: 0)
                }
            }
            "rotate" -> {
                DeviceControl.rotate(context)
                handler.postDelayed({ restartEncoder(ScreenEncoderRotation()) }, 500)
            }
            "requestIdr" -> encoder?.requestKeyFrame()
        }
    }

    private fun ScreenEncoderRotation(): Int {
        val manager = context.getSystemService(Context.DISPLAY_SERVICE) as android.hardware.display.DisplayManager
        return manager.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation ?: 0
    }

    private fun handleTouch(message: JSONObject) {
        val x = message.optDouble("x", 0.0).toFloat()
        val y = message.optDouble("y", 0.0).toFloat()
        when (message.optString("phase")) {
            "began" -> {
                touchStartX = x
                touchStartY = y
                touchX = x
                touchY = y
                touchDownAt = System.currentTimeMillis()
                touchMoved = false
            }
            "moved" -> {
                touchX = x
                touchY = y
                if (Math.abs(x - touchStartX) > 0.004f || Math.abs(y - touchStartY) > 0.004f) {
                    touchMoved = true
                }
            }
            "ended" -> {
                val elapsed = (System.currentTimeMillis() - touchDownAt).coerceAtLeast(40)
                if (touchMoved) {
                    A11yBridge.swipe(
                        touchStartX,
                        touchStartY,
                        touchX,
                        touchY,
                        elapsed.coerceIn(120, 1200),
                    )
                } else {
                    A11yBridge.tap(touchStartX, touchStartY, elapsed.coerceIn(60, 1200))
                }
            }
        }
    }

    private fun handleKey(key: String) {
        when (key) {
            "home" -> A11yBridge.home()
            "back" -> A11yBridge.back()
            "recent" -> A11yBridge.recents()
            "volumeUp" -> reportVolume(DeviceControl.volume(context, true))
            "volumeDown" -> reportVolume(DeviceControl.volume(context, false))
            "mute" -> reportVolume(DeviceControl.mute(context))
            "power" -> {
                val power = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                if (power.isInteractive) DeviceControl.lock(context) else DeviceControl.wake(context)
            }
        }
    }

    /** 把当前媒体音量回传给控制台，让 Web 能看到数值变化。 */
    private fun reportVolume(error: String?) {
        if (error != null) {
            sendJson(JSONObject().put("t", "error").put("message", error))
            return
        }
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        val stream = android.media.AudioManager.STREAM_MUSIC
        sendJson(
            JSONObject()
                .put("t", "volume")
                .put("level", audio.getStreamVolume(stream))
                .put("max", audio.getStreamMaxVolume(stream))
                .put("muted", audio.getStreamVolume(stream) == 0),
        )
    }

    private fun handleScroll(message: JSONObject) {
        val x = message.optDouble("x", 0.5).toFloat().coerceIn(0.05f, 0.95f)
        val y = message.optDouble("y", 0.5).toFloat().coerceIn(0.1f, 0.9f)
        val dy = message.optDouble("dy", 0.0)
        if (dy == 0.0) return
        val distance = (Math.abs(dy) / 800.0).coerceIn(0.05, 0.35).toFloat()
        if (dy > 0) {
            A11yBridge.swipe(x, y + distance / 2, x, y - distance / 2, 200)
        } else {
            A11yBridge.swipe(x, y - distance / 2, x, y + distance / 2, 200)
        }
    }

    private fun setClipboard(text: String) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        manager.setPrimaryClip(ClipData.newPlainText("ADH", text))
    }

    private fun sendJson(json: JSONObject) {
        if (!closed) socket?.send(json.toString())
    }

    private fun sendBinary(data: ByteArray) {
        val socket = socket ?: return
        if (closed) return
        val frame = ByteArray(data.size + 1)
        frame[0] = 1 // FRAME_KIND.h264
        data.copyInto(frame, 1)
        socket.send(frame.toByteString())
    }

    private fun close(reason: String?) {
        if (closed) return
        closed = true
        handler.removeCallbacksAndMessages(null)
        encoder?.stop()
        encoder = null
        socket?.close(1000, "agent stop")
        socket = null
        onClosed(reason)
    }

    fun stop(reason: String? = null) = close(reason)
}

