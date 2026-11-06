package com.adh.portal

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

class PortalAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        A11yBridge.attach(this)
    }

    override fun onUnbind(intent: Intent?): Boolean {
        A11yBridge.detach(this)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        A11yBridge.detach(this)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 纯手势/文本注入，不需要持续读取事件。
    }

    override fun onInterrupt() {
        // 无中断处理。
    }
}