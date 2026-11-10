package com.adh.portal

/**
 * 通知栏 / 状态卡片上展示的文案。
 *
 * 设备端断线原因来自三处：server 下发的 stop reason（`invalid key` /
 * `replaced by new connection` / `heartbeat timeout`）、OkHttp 的异常信息
 * （`timeout` / `Failed to connect to ...`）、以及本地主动关闭时我们自己的
 * 关闭原因（`client stop`）。这些是给开发看的技术细节，直接丢到通知栏上
 * 非技术用户根本看不懂，所以统一在这里翻译成正常说法；原始原因仍然写进
 * App 内的日志（PortalState.append），排查时不会丢信息。
 */
internal object StatusText {
    const val TITLE = "ADH Portal"

    /** 已连上 server，等待控制台操作。 */
    const val CONNECTED = "已连接，等待远程控制"

    /** 首次拉起、还没收到 welcome 时的默认文案。 */
    const val CONNECTING = "正在连接控制台…"

    /** 没配置 server 地址 / Key。 */
    const val NOT_CONFIGURED = "请打开 App 填写服务器地址和 Key"

    /** 没给投屏授权。 */
    const val NO_PROJECTION = "请打开 App 并授权共享屏幕"

    /** 用户或系统撤销了投屏。 */
    const val PROJECTION_STOPPED = "屏幕共享已停止，请重新授权"

    /** 上报设备信息失败（下一轮会自动重试）。 */
    const val SYNC_FAILED = "设备信息上报失败，稍后自动重试"

    /** 用户点了「断开」，或服务被主动停止。 */
    const val STOPPED = "已停止共享"

    /** 投屏已断开、连接还在，等待下一次远程控制。 */
    const val STANDBY = "待命，等待远程控制"

    private val NETWORK_HINTS = listOf(
        "timeout",
        "timed out",
        "failed to connect",
        "unable to resolve",
        "connection reset",
        "connection abort",
        "connection closed",
        "unexpected end of stream",
        "broken pipe",
        "network is unreachable",
        "no route to host",
        "eof",
    )

    /** 会自动重连的中断。 */
    fun reconnecting(raw: String): String {
        val reason = raw.trim().lowercase()
        return when {
            reason.isBlank() -> "连接已断开，正在重连…"
            reason.contains("未配置") -> NOT_CONFIGURED
            NETWORK_HINTS.any { reason.contains(it) } -> "网络不稳定，正在重连…"
            reason.contains("server stop") || reason.contains("服务器") ->
                "控制台已断开连接，正在重连…"
            else -> "连接已断开，正在重连…"
        }
    }

    /** 不会再重连的终止状态。 */
    fun stopped(raw: String): String {
        val reason = raw.trim().lowercase()
        return when {
            reason.contains("invalid key") || reason.contains("key 无效") ->
                "Key 已失效，请打开 App 重新填写"
            reason.contains("replaced") ->
                "设备已在别处重新连接，本次共享已结束"
            reason.contains("heartbeat") ->
                "长时间没有响应，已断开连接"
            reason.contains("client stop") || reason.contains("user stop") -> STOPPED
            reason.isBlank() -> STOPPED
            // 本地传进来的已经是中文，直接用
            reason.any { it.code > 127 } -> raw.trim()
            else -> STOPPED
        }
    }

    /** 投屏流中断（连接本身还在）。 */
    fun streamEnded(raw: String): String {
        val reason = raw.trim()
        val lower = reason.lowercase()
        return when {
            NETWORK_HINTS.any { lower.contains(it) } -> "网络不稳定，投屏已断开"
            reason.isEmpty() || reason.all { it.code < 128 } -> "投屏已结束，等待下一次远程控制"
            else -> reason
        }
    }
}
