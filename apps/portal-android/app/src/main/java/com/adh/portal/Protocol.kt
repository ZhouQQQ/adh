package com.adh.portal

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/** 与 server 端 packages/protocol 对齐的最小 JSON 协议实现。 */
object Protocol {
    const val PROTOCOL_VERSION = 1

    fun hello(): String = JSONObject().apply {
        put("t", "hello")
        put("token", Config.key)
        put(
            "agent",
            JSONObject().apply {
                put(
                    "name",
                    if (Config.displayName.isNotBlank()) {
                        Config.displayName
                    } else {
                        DeviceReporter.marketNameOf()
                    },
                )
                put("instanceId", Config.instanceId)
                put("os", "android")
                put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64")
                put("version", BuildConfig.VERSION_NAME)
                put("capabilities", JSONArray().put("android").put("scrcpy"))
                put("protocolVersion", PROTOCOL_VERSION)
            },
        )
    }.toString()

    fun devicesSync(device: JSONObject): String = JSONObject().apply {
        put("t", "devices.sync")
        put("add", JSONArray().put(device))
        put("remove", JSONArray())
        put("update", JSONArray())
    }.toString()

    fun deviceUpdate(patch: JSONObject): String = JSONObject().apply {
        put("t", "devices.sync")
        put("add", JSONArray())
        put("remove", JSONArray())
        put(
            "update",
            JSONArray().put(
                JSONObject().apply {
                    put("udid", Config.deviceId)
                    put("patch", patch)
                },
            ),
        )
    }.toString()

    fun pong(ts: Long): String = JSONObject().apply {
        put("t", "pong")
        put("ts", ts)
    }.toString()

    fun cmdResult(id: String, ok: Boolean, data: Any? = null, error: String? = null): String =
        JSONObject().apply {
            put("t", "cmd.result")
            put("id", id)
            put("ok", ok)
            if (data != null) put("data", data)
            if (!ok && !error.isNullOrBlank()) put("error", error)
        }.toString()
}
