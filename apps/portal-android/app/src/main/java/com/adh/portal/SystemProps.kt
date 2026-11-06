package com.adh.portal

/** 读取 Android 系统属性（getprop）；无需 root。 */
object SystemProps {
    fun get(key: String): String? {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("getprop", key))
            val value = process.inputStream.bufferedReader().use { it.readText() }.trim()
            process.waitFor()
            value.ifBlank { null }
        } catch (_: Exception) {
            null
        }
    }
}