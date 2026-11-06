package com.adh.portal

import android.app.Activity
import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var addressInput: EditText
    private lateinit var clearAddressButton: TextView
    private lateinit var connectionHint: TextView
    private lateinit var logStatus: TextView
    private lateinit var logView: TextView
    private lateinit var permissionSummary: TextView
    private lateinit var settingsPanel: LinearLayout
    private lateinit var logPanel: LinearLayout
    private lateinit var connectButton: Button
    private lateinit var connectionStateText: TextView
    private lateinit var statusDot: View
    private lateinit var tabSettings: TabView
    private lateinit var tabLog: TabView
    private var connecting = false

    private val handler = Handler(Looper.getMainLooper())
    private val permissionBadges = mutableListOf<Pair<TextView, () -> Boolean>>()
    private var activeTab = 0

    private val refresh = object : Runnable {
        override fun run() {
            renderStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.init(this)
        applyIncoming(intent)
        // 打开 App 视为「要继续连接」，清掉上次主动断开的标记
        Config.userStopped = false
        setContentView(buildUi())
        requestNotificationPermission()
        if (Config.configured) PortalService.start(this)
        handler.post(refresh)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyIncoming(intent)
        addressInput.setText(Config.address)
        if (Config.configured) PortalService.start(this)
    }

    override fun onResume() {
        super.onResume()
        renderStatus()
    }

    override fun onDestroy() {
        handler.removeCallbacks(refresh)
        super.onDestroy()
    }

    private fun applyIncoming(intent: Intent?) {
        val address = intent?.getStringExtra("address")
        if (!address.isNullOrBlank()) {
            Config.setAddress(address)
            return
        }
        val server = intent?.getStringExtra("server")
        val key = intent?.getStringExtra("key")
        if (!server.isNullOrBlank()) Config.serverUrl = server
        if (!key.isNullOrBlank()) Config.key = key
    }

    /* ------------------------------------------------------------ */
    /* UI                                                             */
    /* ------------------------------------------------------------ */

    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(BG)
            isFillViewport = true
            clipToPadding = false
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(24))
        }
        scroll.addView(content)

        content.addView(header())
        content.addView(space(14))

        settingsPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        settingsPanel.addView(connectionCard())
        settingsPanel.addView(space(12))
        settingsPanel.addView(permissionCard())
        content.addView(settingsPanel)

        logPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        logPanel.addView(logCard())
        content.addView(logPanel)

        root.addView(
            scroll,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )
        root.addView(
            View(this).apply {
                setBackgroundColor(Color.parseColor("#e4e4e7"))
            },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)),
        )
        val tabBar = tabs().apply {
            setBackgroundColor(Color.WHITE)
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        root.addView(
            tabBar,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        applyInsets(scroll, tabBar)
        selectTab(0)
        return root
    }

    private fun header(): ViewGroup {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val logoWrap = LinearLayout(this).apply {
            setBackgroundDrawable(rounded("#18181b", 11, 0, null))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
        }
        logoWrap.addView(
            ImageView(this).apply {
                setImageResource(R.drawable.brand_mark)
                layoutParams = LinearLayout.LayoutParams(dp(28), dp(28))
            },
        )
        row.addView(logoWrap)
        row.addView(space(10, true))
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(label("ADH Portal", 19f, INK, true))
        // 顶部显示市场名（如 iQOO Z10 Turbo+），而不是 V2507A 这种型号代码
        texts.addView(label(DeviceReporter.marketNameOf(), 11f, MUTED, false))
        row.addView(texts)
        return row
    }

private fun tabs(): ViewGroup {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        tabSettings = tab(R.drawable.ic_tab_settings, "设置") { selectTab(0) }
        tabLog = tab(R.drawable.ic_tab_logs, "日志") { selectTab(1) }
        row.addView(tabSettings.root, weight(1f))
        row.addView(tabLog.root, weight(1f))
        return row
    }

    /** 微信底部 Tab：图标在上、文字在下。 */
    private fun tab(iconRes: Int, text: String, action: () -> Unit): TabView {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(0, dp(7), 0, dp(6))
            isClickable = true
            setOnClickListener { action() }
        }
        val icon = ImageView(this).apply {
            setImageResource(iconRes)
            layoutParams = LinearLayout.LayoutParams(dp(23), dp(23))
            scaleType = ImageView.ScaleType.CENTER_INSIDE
        }
        val label = label(text, 10f, MUTED, false).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(2), 0, 0)
        }
        root.addView(icon)
        root.addView(label)
        return TabView(root, icon, label)
    }

    private fun selectTab(index: Int) {
        activeTab = index
        settingsPanel.visibility = if (index == 0) View.VISIBLE else View.GONE
        logPanel.visibility = if (index == 1) View.VISIBLE else View.GONE
        styleTab(tabSettings, index == 0)
        styleTab(tabLog, index == 1)
    }

    private fun styleTab(tab: TabView, active: Boolean) {
        val color = Color.parseColor(if (active) "#07C160" else "#71717a")
        tab.icon.setColorFilter(color)
        tab.label.setTextColor(color)
        tab.label.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
    }

    private data class TabView(
        val root: LinearLayout,
        val icon: ImageView,
        val label: TextView,
    )

    private fun connectionCard(): ViewGroup {
        val card = card()
        val addressHead = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        addressHead.addView(label("连接地址", 13f, MUTED, false), weight(1f))
        addressHead.addView(tinyButton("扫一扫") { startScan() })
        card.addView(addressHead)
        card.addView(space(6))
        addressInput = EditText(this).apply {
            hint = "ws://<server-ip>:8080?key=adh_xxx"
            setText(Config.address)
            textSize = 13f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(false)
            setPadding(dp(12), dp(10), dp(54), dp(10))
            setBackgroundDrawable(rounded("#fafafa", 9, 1, "#e4e4e7"))
            setTextColor(INK)
            setHintTextColor(FAINT)
        }
        // 清空按钮嵌在输入框右侧内部，视觉上是一个整体
        val addressWrap = FrameLayout(this)
        addressWrap.addView(
            addressInput,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        clearAddressButton = label("清空", 12f, MUTED, false).apply {
            setPadding(dp(8), dp(6), dp(8), dp(6))
            isClickable = true
            setOnClickListener { clearAddress() }
        }
        addressWrap.addView(
            clearAddressButton,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL,
            ).apply { marginEnd = dp(8) },
        )
        card.addView(addressWrap)
        card.addView(space(6))
        connectionHint = label("", 12f, FAINT, false)
        card.addView(connectionHint)
        card.addView(space(10))

        // 左侧独立状态块 + 右侧独立动作按钮（连接 / 断开）
        val actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val stateWrap = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setBackgroundDrawable(rounded("#fafafa", 9, 1, "#e4e4e7"))
        }
        statusDot = View(this).apply {
            setBackgroundDrawable(rounded("#a1a1aa", 999, 0, null))
            layoutParams = LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(8) }
        }
        stateWrap.addView(statusDot)
        connectionStateText = label("未连接", 13f, MUTED, true)
        stateWrap.addView(connectionStateText)
        actionRow.addView(
            stateWrap,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        actionRow.addView(space(10, true))

        connectButton = primaryButton("连接") { toggleConnection() }.apply {
            setCompoundDrawablePadding(dp(8))
            compoundDrawableTintList = ColorStateList.valueOf(Color.WHITE)
            minWidth = 0
        }
        // 状态块和按钮各占一半宽度，视觉上对齐
        actionRow.addView(
            connectButton,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        card.addView(actionRow)
        return card
    }

    private fun permissionCard(): ViewGroup {
        val card = card()
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(label("授权状态", 15f, INK, true), weight(1f))
        permissionSummary = label("", 11f, MUTED, false)
        head.addView(permissionSummary)
        card.addView(head)
        card.addView(space(2))
        card.addView(label("全部变绿后即可被控制台操作", 10f, FAINT, false))
        card.addView(space(6))

        addPermission(card, "屏幕录制", "投屏、截图与 AI 视觉", { ProjectionController.hasConsent }) {
            requestProjection()
        }
        addPermission(card, "无障碍服务", "点击、滑动、返回、主页", { A11yBridge.ready }) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        addPermission(card, "默认输入法", "输入中文与特殊字符", { isImeEnabled() }) {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        addPermission(card, "设备管理员", "远程锁屏 / 息屏", { isAdminActive() }) {
            requestAdmin()
        }
        addPermission(card, "所有文件访问", "应用安装与文件读取", { hasAllFiles() }) {
            requestAllFiles()
        }
        addPermission(card, "安装未知应用", "远程安装 APK 需要", { canInstallPackages() }) {
            requestInstallPackages()
        }
        addPermission(card, "修改系统设置", "远程旋转屏幕", { Settings.System.canWrite(this) }) {
            requestWriteSettings()
        }
        addPermission(card, "通知权限", "前台服务常驻，防止被系统清理", { hasNotificationPermission() }) {
            requestNotificationPermission()
        }
        addPermission(card, "位置信息", "显示 WiFi 名称（系统强制要求）", {
            hasWifiPermission() && isLocationEnabled()
        }) {
            requestWifiPermission()
        }
        addPermission(card, "忽略电池优化", "后台保持连接", { KeepAlive.isIgnoringBattery(this) }) {
            requestBattery()
        }
        addPermission(card, "自启动 / 后台运行", "厂商 ROM 需手动允许，重启后自动连接", {
            Config.autoStartConfirmed
        }) {
            KeepAlive.openAutoStartSettings(this)
            // 厂商开关没有公开 API，只能按「已引导用户去设置」记录
            Config.autoStartConfirmed = true
            toast("已打开系统的自启动设置，请允许本应用后台运行")
            renderStatus()
        }
        return card
    }

    private fun addPermission(
        parent: LinearLayout,
        title: String,
        desc: String,
        granted: () -> Boolean,
        open: () -> Unit,
    ) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(8))
            isClickable = true
            setOnClickListener { open() }
        }
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        texts.addView(label(title, 13f, INK, false))
        texts.addView(label(desc, 10f, MUTED, false))
        row.addView(texts)
        row.addView(space(6, true))
        val badge = label("", 10f, Color.WHITE, true).apply {
            setPadding(dp(7), dp(2), dp(7), dp(2))
        }
        row.addView(badge)
        parent.addView(row)
        permissionBadges.add(badge to granted)
        renderBadge(badge, granted())
    }

    private fun logCard(): ViewGroup {
        val card = card()
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(label("运行日志", 15f, INK, true), weight(1f))
        head.addView(
            tinyButton("复制") {
                val clipboard = getSystemService(ClipboardManager::class.java)
                clipboard.setPrimaryClip(ClipData.newPlainText("ADH Portal", PortalState.log))
                toast("日志已复制")
            },
        )
        head.addView(space(6, true))
        head.addView(
            tinyButton("清空") {
                PortalState.clear()
                logView.text = ""
            },
        )
        card.addView(head)
        card.addView(space(6))
        logStatus = label("", 12f, MUTED, false)
        card.addView(logStatus)
        card.addView(space(8))
        logView = label("", 10f, MUTED, false).apply {
            setTextIsSelectable(true)
            typeface = Typeface.MONOSPACE
            setBackgroundDrawable(rounded("#fafafa", 8, 1, "#e4e4e7"))
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }
        card.addView(logView)
        return card
    }

    /** 扫码连接：二维码内容是完整地址（ws://ip:port?key=xxx）。 */
    private fun startScan() {
        val options = com.journeyapps.barcodescanner.ScanOptions().apply {
            setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
            setPrompt("对准网页上的连接二维码")
            setBeepEnabled(false)
            setOrientationLocked(false)
            setBarcodeImageEnabled(false)
        }
        val intent = com.journeyapps.barcodescanner.ScanContract()
            .createIntent(this, options)
        @Suppress("DEPRECATION")
        startActivityForResult(intent, SCAN_REQUEST)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SCAN_REQUEST) return
        val contents = runCatching {
            com.journeyapps.barcodescanner.ScanContract()
                .parseResult(resultCode, data)
                .contents
                ?.trim()
        }.getOrNull()
        if (!contents.isNullOrBlank()) applyScannedAddress(contents)
    }

    private fun applyScannedAddress(raw: String) {
        if (!Config.setAddress(raw)) {
            toast("二维码内容不是有效的连接地址")
            return
        }
        addressInput.setText(Config.address)
        Config.userStopped = false
        if (!ProjectionController.hasConsent) {
            toast("地址已填入，请先授权「共享屏幕」")
            requestProjection()
            return
        }
        connecting = true
        PortalState.status = "正在连接…"
        renderStatus()
        PortalService.start(this)
    }

    /* ------------------------------------------------------------ */
    /* 状态                                                           */
    /* ------------------------------------------------------------ */

    private fun toggleConnection() {
        if (PortalState.connected) {
            PortalService.stop(this)
            PortalState.connected = false
            PortalState.status = "已断开"
            connecting = false
            renderStatus()
            toast("已断开")
            return
        }
        if (!Config.setAddress(addressInput.text.toString())) {
            toast("连接地址无效，请粘贴「设备直连」生成的完整地址")
            return
        }
        addressInput.setText(Config.address)
        // 没有投屏授权先引导授权，授权回调里会自动连接
        if (!ProjectionController.hasConsent) {
            toast("请先授权「共享屏幕」")
            requestProjection()
            return
        }
        connecting = true
        PortalState.status = "正在连接…"
        renderStatus()
        PortalService.start(this)
    }

    /** 清空已保存的地址和 Key，回到未配置状态。 */
    private fun clearAddress() {
        if (PortalState.connected) {
            toast("请先断开连接再清空地址")
            return
        }
        Config.clearAddress()
        addressInput.setText("")
        PortalState.status = ""
        PortalState.connected = false
        connecting = false
        renderStatus()
        toast("连接地址已清空")
    }

    private fun renderStatus() {
        val status = PortalState.status
        val configured = Config.configured
        val online = PortalState.connected
        val needsProjection = configured && !ProjectionController.hasConsent
        val failed = !online &&
            (status.contains("失败") || status.contains("中断") || status.contains("已停止"))
        if (online || failed) connecting = false

        // 左侧状态块：只表达「连没连上」，与按钮职责分开
        connectionStateText.text = when {
            online -> "已连接"
            connecting -> "连接中…"
            needsProjection -> "待授权投屏"
            failed -> "连接失败"
            else -> "未连接"
        }
        connectionStateText.setTextColor(
            Color.parseColor(
                when {
                    online -> "#16a34a"
                    needsProjection -> "#d97706"
                    failed -> "#dc2626"
                    else -> "#71717a"
                },
            ),
        )
        statusDot.background = rounded(
            when {
                online -> "#16a34a"
                connecting -> "#d97706"
                needsProjection -> "#d97706"
                failed -> "#dc2626"
                else -> "#a1a1aa"
            },
            999,
            0,
            null,
        )

        // 右侧按钮：只负责动作
        connectButton.text = when {
            connecting -> "连接中…"
            online -> "断开"
            needsProjection -> "共享屏幕"
            failed -> "重新连接"
            else -> "连接"
        }
        connectButton.isEnabled = !connecting
        // 连上后锁定地址，避免误改把连接弄断；断开或清空后恢复编辑
        addressInput.isEnabled = !online
        addressInput.alpha = if (online) 0.55f else 1f
        clearAddressButton.isEnabled = !online && !connecting
        clearAddressButton.alpha = if (clearAddressButton.isEnabled) 1f else 0.4f
        val iconRes = when {
            connecting || online -> 0
            failed -> R.drawable.ic_refresh
            else -> R.drawable.ic_link
        }
        connectButton.setCompoundDrawablesWithIntrinsicBounds(iconRes, 0, 0, 0)
        connectButton.setBackgroundDrawable(
            rounded(
                if (online) "#dc2626" else "#18181b",
                9,
                0,
                null,
            ),
        )

        // 连上后不再显示任何地址文案：输入框里已经是完整地址，重复会显得重叠
        val hintText = when {
            !configured -> "请粘贴控制台生成的连接地址"
            online -> ""
            needsProjection -> "点「共享屏幕」授权后会自动连接"
            failed -> status
            status.isBlank() -> "正在连接…"
            else -> status
        }
        connectionHint.text = hintText
        connectionHint.visibility = if (hintText.isBlank()) View.GONE else View.VISIBLE
        connectionHint.setTextColor(
            Color.parseColor(
                when {
                    !configured -> "#d97706"
                    online -> "#16a34a"
                    failed -> "#dc2626"
                    else -> "#71717a"
                },
            ),
        )

        logStatus.text = when {
            !configured -> "● 未配置"
            online -> "● 已连接 ${Config.serverUrl}"
            status.isBlank() -> "● 正在连接…"
            else -> "● $status"
        }
        logStatus.setTextColor(
            Color.parseColor(if (online) "#16a34a" else if (failed) "#dc2626" else "#71717a"),
        )

        var granted = 0
        for ((badge, check) in permissionBadges) {
            val ok = check()
            if (ok) granted++
            renderBadge(badge, ok)
        }
        permissionSummary.text = "$granted/${permissionBadges.size}"
        logView.text = PortalState.log.takeLast(6000)
    }

    private fun renderBadge(badge: TextView, granted: Boolean) {
        badge.text = if (granted) "已授权" else "未授权"
        badge.setTextColor(Color.parseColor(if (granted) "#16a34a" else "#dc2626"))
        badge.background = rounded(if (granted) "#dcfce7" else "#fee2e2", 999, 0, null)
    }

    private fun requestProjection() {
        AlertDialog.Builder(this)
            .setTitle("共享屏幕")
            .setMessage(
                "系统弹窗里请选择「共享整个屏幕」，不要选「共享当前应用」或「共享一个应用」，否则控制台看到的是黑屏。",
            )
            .setPositiveButton("去授权") { _, _ ->
                startActivity(Intent(this, CaptureActivity::class.java))
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun requestAdmin() {
        val component = ComponentName(this, AdminReceiver::class.java)
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
            .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, component)
            .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "用于远程锁屏 / 息屏")
        startActivity(intent)
    }

    private fun isAdminActive(): Boolean {
        val dpm = getSystemService(DevicePolicyManager::class.java)
        return dpm.isAdminActive(ComponentName(this, AdminReceiver::class.java))
    }

    private fun requestAllFiles() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            startActivity(Intent(Settings.ACTION_APPLICATION_SETTINGS))
            return
        }
        startActivity(
            Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                .setData(Uri.parse("package:$packageName")),
        )
    }

    private fun hasAllFiles(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.os.Environment.isExternalStorageManager()
        } else {
            checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                PackageManager.PERMISSION_GRANTED
        }

    private fun requestWriteSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS)
                    .setData(Uri.parse("package:$packageName")),
            )
        }
    }

    private fun requestBattery() {
        startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:$packageName")),
        )
    }

    private fun isImeEnabled(): Boolean {
        val ime = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        return ime.enabledInputMethodList.any { it.packageName == packageName }
    }

    /** 是否允许安装未知来源应用（Android 8+ 按来源应用单独授权）。 */
    private fun canInstallPackages(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            packageManager.canRequestPackageInstalls()
        } else {
            true
        }

    /**
     * 跳到「安装未知应用」授权页；跳不过去就退回应用详情页，
     * vivo / iQOO 的「解除限制」只在应用信息右上角，系统没有标准入口。
     */
    private fun requestInstallPackages() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val opened = runCatching {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                        .setData(Uri.parse("package:$packageName")),
                )
            }.isSuccess
            if (opened) return
        }
        startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        toast("厂商限制：请在应用信息右上角 ⋮ 里「解除限制」")
    }

    private fun hasNotificationPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

    /** Android 13+ 用 NEARBY_WIFI_DEVICES，更早版本只能靠定位权限。 */
    private fun wifiPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            android.Manifest.permission.NEARBY_WIFI_DEVICES
        } else {
            android.Manifest.permission.ACCESS_FINE_LOCATION
        }

    private fun hasWifiPermission(): Boolean =
        checkSelfPermission(wifiPermission()) == PackageManager.PERMISSION_GRANTED

    private fun isLocationEnabled(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getSystemService(android.location.LocationManager::class.java).isLocationEnabled
        } else {
            true
        }

    private fun requestWifiPermission() {
        if (!hasWifiPermission()) {
            requestPermissions(arrayOf(wifiPermission()), 3)
            return
        }
        if (!isLocationEnabled()) {
            startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
            toast("打开系统定位后，才能读取到 WiFi 名称")
        }
    }

    private fun requestNotificationPermission() {
        if (checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(
                arrayOf(android.Manifest.permission.READ_PHONE_STATE),
                3,
            )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            if (checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), 2)
            }
        }
    }

    /* ------------------------------------------------------------ */
    /* 样式                                                           */
    /* ------------------------------------------------------------ */

    private fun applyInsets(scroll: ScrollView, tabBar: View) {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or
            View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            scroll.setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                view.setPadding(0, bars.top, 0, 0)
                tabBar.setPadding(dp(10), dp(8), dp(10), dp(8) + bars.bottom)
                insets
            }
        } else {
            @Suppress("DEPRECATION")
            scroll.setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(0, insets.systemWindowInsetTop, 0, 0)
                tabBar.setPadding(
                    dp(10),
                    dp(8),
                    dp(10),
                    dp(8) + insets.systemWindowInsetBottom,
                )
                insets
            }
        }
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(14), dp(12), dp(14), dp(12))
        setBackgroundDrawable(rounded("#ffffff", 12, 1, "#e4e4e7"))
    }

    private fun primaryButton(text: String, action: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            textSize = 14f
            setAllCaps(false)
            setTextColor(Color.WHITE)
            setBackgroundDrawable(rounded("#18181b", 9, 0, null))
            setOnClickListener { action() }
            minHeight = 0
            minimumHeight = 0
            // 图标 + 文字作为一个整体居中，避免图标单独贴到按钮左边
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }

    private fun outlineButton(text: String, action: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            textSize = 14f
            setAllCaps(false)
            setTextColor(INK)
            setBackgroundDrawable(rounded("#ffffff", 9, 1, "#e4e4e7"))
            setOnClickListener { action() }
            minHeight = 0
            minimumHeight = 0
            setPadding(0, dp(10), 0, dp(10))
        }

    private fun tinyButton(text: String, action: () -> Unit): TextView =
        label(text, 11f, MUTED, false).apply {
            setPadding(dp(8), dp(4), dp(8), dp(4))
            background = rounded("#f4f4f5", 6, 1, "#e4e4e7")
            isClickable = true
            setOnClickListener { action() }
        }

    private fun label(value: String, size: Float, color: Int, bold: Boolean): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            includeFontPadding = false
        }

    private fun rounded(
        fill: String,
        radiusDp: Int,
        strokeDp: Int,
        strokeColor: String?,
    ): GradientDrawable = GradientDrawable().apply {
        setColor(Color.parseColor(fill))
        cornerRadius = if (radiusDp >= 999) 999f else dp(radiusDp).toFloat()
        if (strokeDp > 0 && strokeColor != null) {
            setStroke(dp(strokeDp), Color.parseColor(strokeColor))
        }
    }

    private fun weight(value: Float): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, value)

    private fun space(height: Int, horizontal: Boolean = false): View =
        View(this).apply {
            layoutParams = if (horizontal) {
                LinearLayout.LayoutParams(dp(height), 0)
            } else {
                LinearLayout.LayoutParams(0, dp(height))
            }
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private const val SCAN_REQUEST = 9101
        private val BG = Color.parseColor("#f4f4f5")
        private val INK = Color.parseColor("#09090b")
        private val MUTED = Color.parseColor("#52525b")
        private val FAINT = Color.parseColor("#a1a1aa")
    }
}

/** 供前台服务与 UI 共享的状态。 */
object PortalState {
    @Volatile var status: String = ""
    @Volatile var log: String = ""

    /** WebSocket 是否已连上 server（收到 welcome 即算成功，与控制台是否有人在看无关）。 */
    @Volatile var connected: Boolean = false

    fun append(line: String) {
        val time = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault())
            .format(java.util.Date())
        log = (log + "[$time] $line\n").takeLast(8000)
    }

    fun clear() {
        log = ""
    }
}













