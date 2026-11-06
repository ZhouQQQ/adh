package com.adh.portal

import android.inputmethodservice.InputMethodService
import android.view.View

/**
 * 备用输入通道：无障碍 ACTION_SET_TEXT 被拒绝时（自定义输入框、密码框），
 * 通过输入法 commitText 输入，支持中文等非 ASCII 内容。
 */
class PortalImeService : InputMethodService() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onCreateInputView(): View = View(this)

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun commit(text: String) {
        currentInputConnection?.commitText(text, 1)
    }

    companion object {
        @Volatile private var instance: PortalImeService? = null

        fun type(text: String): Boolean {
            val service = instance ?: return false
            service.commit(text)
            return true
        }

        val available: Boolean get() = instance != null
    }
}