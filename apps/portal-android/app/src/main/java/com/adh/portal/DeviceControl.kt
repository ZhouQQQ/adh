package com.adh.portal

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.media.AudioManager
import android.os.PowerManager
import android.provider.Settings

/** 音量、锁屏、亮屏、系统旋转。 */
object DeviceControl {
    fun volume(context: Context, up: Boolean): String? {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val stream = AudioManager.STREAM_MUSIC
        return runCatching {
            val max = audio.getStreamMaxVolume(stream).coerceAtLeast(1)
            val current = audio.getStreamVolume(stream)
            // 按最大值换算步长，保证每次都能听到变化
            val step = maxOf(1, (max / 15f).toInt())
            val target = (if (up) current + step else current - step).coerceIn(0, max)
            audio.setStreamVolume(stream, target, AudioManager.FLAG_SHOW_UI)
            null
        }.getOrElse { it.message ?: "调整音量失败" }
    }

    fun mute(context: Context): String? {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return runCatching {
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0)
            null
        }.getOrElse { it.message ?: "静音失败" }
    }

    fun lock(context: Context): String? {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(context, AdminReceiver::class.java)
        if (!dpm.isAdminActive(admin)) {
            return "未启用设备管理员，无法锁屏。请到 App 的权限向导里启用。"
        }
        dpm.lockNow()
        return null
    }

    @Suppress("DEPRECATION")
    fun wake(context: Context): String? {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val lock = power.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "adh:portal:wake",
        )
        lock.acquire(3000)
        return null
    }

    fun rotate(context: Context, direction: Int = 1): String? {
        if (!Settings.System.canWrite(context)) {
            return "未授予修改系统设置权限，无法旋转屏幕"
        }
        val resolver = context.contentResolver
        val current = Settings.System.getInt(resolver, Settings.System.USER_ROTATION, 0)
        val next = ((current + direction) % 4 + 4) % 4
        Settings.System.putInt(resolver, Settings.System.ACCELEROMETER_ROTATION, 0)
        Settings.System.putInt(resolver, Settings.System.USER_ROTATION, next)
        return null
    }
}