package com.adh.portal

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 设备 → server 的主通道：/ws/agent。
 *
 * 复用现有 agent 协议：hello → welcome，devices.sync 上报设备，cmd/cmd.result 收发指令。
 * 断线自动重连；key 失效或被同 key 新连接替换时停止。
 */
class AgentClient(private val listener: Listener) {
    interface Listener {
        fun onConnected()
        fun onDisconnected(reason: String)
        fun onStopped(reason: String)
        fun onCommand(id: String, action: String, params: JSONObject)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var socket: WebSocket? = null
    @Volatile private var stopped = false
    @Volatile var connected = false
        private set
    private var attempt = 0
    private var reconnectPending = false

    fun start() {
        if (stopped) stopped = false
        if (!Config.configured) {
            listener.onDisconnected("未配置 server 地址或 key")
            return
        }
        connect()
    }

    fun stop() {
        stopped = true
        connected = false
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "client stop")
        socket = null
    }

    fun send(text: String): Boolean = socket?.send(text) == true

    private fun connect() {
        if (stopped || !Config.configured) return
        val url = Config.serverUrl + "/ws/agent"
        android.util.Log.i("ADH", "agent connect $url")
        val request = Request.Builder().url(url).build()
        socket = http.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    attempt = 0
                    PortalState.append("已连接 server，发送 hello")
                    webSocket.send(Protocol.hello())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handle(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    android.util.Log.i("ADH", "agent closed $code $reason")
                    connected = false
                    if (socket === webSocket) socket = null
                    listener.onDisconnected(reason.ifBlank { "连接已关闭" })
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    android.util.Log.w("ADH", "agent failure", t)
                    connected = false
                    if (socket === webSocket) socket = null
                    listener.onDisconnected(t.message ?: "网络错误")
                    scheduleReconnect()
                }
            },
        )
    }

    private fun handle(text: String) {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (json.optString("t")) {
            "welcome" -> {
                android.util.Log.i("ADH", "agent welcome")
                json.optString("token").takeIf { it.isNotBlank() }?.let { Config.agentToken = it }
                connected = true
                attempt = 0
                listener.onConnected()
            }
            "ping" -> send(Protocol.pong(json.optLong("ts", System.currentTimeMillis())))
            "cmd" -> {
                val id = json.optString("id")
                val action = json.optString("action")
                val params = json.optJSONObject("params") ?: JSONObject()
                if (id.isNotBlank() && action.isNotBlank()) {
                    listener.onCommand(id, action, params)
                }
            }
            "stop" -> {
                val reason = json.optString("reason")
                stopped = true
                connected = false
                socket?.close(1000, "server stop")
                socket = null
                listener.onStopped(reason.ifBlank { "server 已停止会话" })
            }
        }
    }

    private fun scheduleReconnect() {
        if (stopped || reconnectPending) return
        reconnectPending = true
        val delay = (1000L shl attempt.coerceAtMost(4)).coerceAtMost(15_000L)
        attempt++
        handler.postDelayed(
            {
                reconnectPending = false
                if (!stopped) connect()
            },
            delay,
        )
    }
}



