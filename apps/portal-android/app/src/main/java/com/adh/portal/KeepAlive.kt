package com.adh.portal

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings

/**
 * 后台保活。
 *
 * 目标设备是长期在线、无人操作的农场机，策略是"多层冗余"：
 *
 *  1. 前台服务（[PortalService]，START_STICKY，`stopWithTask=false`）
 *  2. PARTIAL_WAKE_LOCK：息屏后 CPU 不被冻结（10 分钟超时，每 8 分钟续期）
 *  3. JobScheduler：15 分钟周期任务，`persisted` 重启后仍有效
 *  4. AlarmManager：30 分钟兜底，Doze 下也能唤醒
 *  5. 屏幕解锁 / 网络恢复 / 充电时立即拉活
 *  6. 任务被划掉后延时重启
 *
 * 不依赖 root 或系统签名。厂商 ROM 的"自启动"只能由用户手动开，
 * 用 [openAutoStartSettings] 跳到对应的设置页。
 *
 * 注意：Android 12+ 后台启动前台服务受限，但本应用声明了
 * SYSTEM_ALERT_WINDOW，属于官方豁免情形，无需真的创建悬浮窗。
 */
object KeepAlive {
    private const val TAG = "ADH"
    private const val WAKE_TAG = "adh:portal"
    private const val WAKE_TIMEOUT_MS = 10 * 60 * 1000L
    private const val WAKE_RENEW_MS = 8 * 60 * 1000L
    private const val ALARM_INTERVAL_MS = 30 * 60 * 1000L
    private const val JOB_INTERVAL_MS = 15 * 60 * 1000L

    internal const val ACTION_ALARM = "com.adh.portal.ALARM"
    internal const val ALARM_REQUEST = 2201
    internal const val JOB_ID = 2201

    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var receiver: KeepAliveReceiver? = null
    private var appContext: Context? = null

    private val renew = object : Runnable {
        override fun run() {
            // acquireWakeLock 内部会续期，这里只负责重新拿锁
            acquireWakeLock(appContext ?: return)
        }
    }

    /** 服务起来时调用：持有唤醒锁并排好所有兜底定时器。 */
    fun onServiceStarted(context: Context) {
        val app = context.applicationContext
        appContext = app
        acquireWakeLock(app)
        acquireWifiLock(app)
        scheduleJob(app)
        scheduleAlarm(app)
        registerReceivers(app)
    }

    /** 用户主动停止时调用：撤掉全部保活手段。 */
    fun onServiceStopped(context: Context) {
        val app = context.applicationContext
        handler.removeCallbacks(renew)
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wifiLock = null
        cancelJob(app)
        cancelAlarm(app)
        unregisterReceivers(app)
        appContext = null
    }

    /**
     * 所有拉活入口统一走这里：开机、闹钟、Job、解锁、网络恢复、任务被划掉。
     * 已经配置过 server 且允许自启动才会真正拉起服务。
     */
    fun revive(context: Context, reason: String) {
        Config.init(context)
        if (!Config.configured) return
        if (!Config.autoStart) return
        // 用户主动停止过：不要自作聪明地拉回来
        if (Config.userStopped) return
        android.util.Log.i(TAG, "keepalive revive: $reason")
        PortalService.start(context)
    }

    /** 重新排一次 30 分钟兜底闹钟（Alarm 触发后调用）。 */
    fun scheduleNextAlarm(context: Context) {
        scheduleAlarm(context.applicationContext)
    }

    /** 任务被划掉 / 服务被停止后延时重启，避开系统的立即回收窗口。 */
    fun scheduleRestart(context: Context, delayMs: Long = 1_500L) {
        val app = context.applicationContext
        val intent = Intent(app, KeepAliveReceiver::class.java).setAction(ACTION_ALARM)
        val pending = PendingIntent.getBroadcast(
            app,
            ALARM_REQUEST,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val manager = app.getSystemService(AlarmManager::class.java) ?: return
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            runCatching { manager.canScheduleExactAlarms() }.getOrDefault(false)
        runCatching {
            if (canExact) {
                manager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + delayMs,
                    pending,
                )
            } else {
                manager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + delayMs,
                    pending,
                )
            }
        }
    }

    /** 是否已加入电池优化白名单（Doze 不限制后台）。 */
    fun isIgnoringBattery(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)
            ?.isIgnoringBatteryOptimizations(context.packageName) == true

    /**
     * 跳到厂商的「自启动 / 后台运行」设置页。
     * 各 ROM 的 Activity 名字不公开，按常见组合逐个试探，全部失败就回到应用详情页。
     */
    fun openAutoStartSettings(context: Context) {
        val candidates = listOf(
            // 小米 / Redmi
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
            ),
            // 华为
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            ),
            // 荣耀
            ComponentName(
                "com.hihonor.systemmanager",
                "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            ),
            // OPPO / 一加 / realme
            ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            ),
            ComponentName(
                "com.coloros.oppoguardelf",
                "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
            ),
            // vivo / iQOO
            ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            ),
            ComponentName(
                "com.iqoo.secure",
                "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            ),
            // 三星
            ComponentName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity",
            ),
            // 魅族
            ComponentName(
                "com.meizu.safe",
                "com.meizu.safe.permission.SmartBGActivity",
            ),
        )
        for (component in candidates) {
            val intent = Intent().setComponent(component)
            val resolved = runCatching {
                context.packageManager.resolveActivity(intent, 0) != null
            }.getOrDefault(false)
            if (!resolved) continue
            val started = runCatching {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
            if (started) return
        }
        runCatching {
            context.startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:${context.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    /* ---------------------------------------------------------------- */

    private fun acquireWakeLock(context: Context) {
        val manager = context.getSystemService(PowerManager::class.java) ?: return
        val current = wakeLock
        if (current != null && current.isHeld) {
            current.release()
        }
        val lock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG).apply {
            setReferenceCounted(false)
        }
        runCatching { lock.acquire(WAKE_TIMEOUT_MS) }
        wakeLock = lock
        handler.removeCallbacks(renew)
        handler.postDelayed(renew, WAKE_RENEW_MS)
    }

    /**
     * 持有一个高性能 WiFi 锁，避免手机锁屏后 WiFi 进入省电休眠，
     * 导致 WebSocket 和投屏流被断开（这是「App 显示已连接但控制连不上」的常见原因）。
     */
    private fun acquireWifiLock(context: Context) {
        if (wifiLock?.isHeld == true) return
        val manager = context.getSystemService(android.net.wifi.WifiManager::class.java) ?: return
        val lock = manager.createWifiLock(
            android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "adh:portal-wifi",
        ).apply { setReferenceCounted(false) }
        runCatching { lock.acquire() }
        wifiLock = lock
    }

    private fun scheduleJob(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
        val component = ComponentName(context, KeepAliveJobService::class.java)
        val info = JobInfo.Builder(JOB_ID, component)
            .setPersisted(true)
            .setPeriodic(JOB_INTERVAL_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .build()
        runCatching { scheduler.schedule(info) }
    }

    private fun cancelJob(context: Context) {
        context.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
    }

    private fun scheduleAlarm(context: Context) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = Intent(context, KeepAliveReceiver::class.java).setAction(ACTION_ALARM)
        val pending = PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val triggerAt = System.currentTimeMillis() + ALARM_INTERVAL_MS
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            runCatching { manager.canScheduleExactAlarms() }.getOrDefault(false)
        runCatching {
            if (canExact) {
                manager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pending,
                )
            } else {
                manager.setAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAt,
                    pending,
                )
            }
        }
    }

    private fun cancelAlarm(context: Context) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = Intent(context, KeepAliveReceiver::class.java).setAction(ACTION_ALARM)
        val pending = PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.cancel(pending)
    }

    private fun registerReceivers(context: Context) {
        if (receiver != null) return
        val target = KeepAliveReceiver()
        val filter = IntentFilter().apply {
            // 解锁：用户大概率会操作手机，是最自然的复活时机
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_SCREEN_ON)
            // 网络恢复：WS 断了要尽快重连
            addAction(ConnectivityManager.CONNECTIVITY_ACTION)
            // 充电：农场机通常长期供电
            addAction(Intent.ACTION_POWER_CONNECTED)
        }
        val registered = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(target, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                context.registerReceiver(target, filter)
            }
        }.isSuccess
        if (registered) receiver = target
    }

    private fun unregisterReceivers(context: Context) {
        val target = receiver ?: return
        runCatching { context.unregisterReceiver(target) }
        receiver = null
    }
}

/** JobScheduler 的周期任务，只负责"把服务叫起来"。 */
class KeepAliveJobService : JobService() {
    override fun onStartJob(params: JobParameters?): Boolean {
        KeepAlive.revive(this, "job")
        jobFinished(params, false)
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean = true
}

/** AlarmManager 与系统广播的统一入口。 */
class KeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action == KeepAlive.ACTION_ALARM) {
            KeepAlive.scheduleNextAlarm(context)
        }
        KeepAlive.revive(context, action)
    }
}
