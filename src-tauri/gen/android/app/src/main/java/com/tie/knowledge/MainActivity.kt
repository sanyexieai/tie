package com.tie.knowledge

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view == null) {
          // WebView 尚未就绪时不要 finish，避免左滑直接退出。
          moveTaskToBack(true)
          return
        }
        view.evaluateJavascript(
          "(function(){try{return !!(window.__tieHandleAndroidBack&&window.__tieHandleAndroidBack());}catch(e){return false;}})()",
          { result ->
            // true = 已在应用根界面，回到桌面（保留进程）；false = 前端已做后退。
            if (result == "true") {
              moveTaskToBack(true)
            }
          },
        )
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    super.onWebViewCreate(webView)
  }
}
