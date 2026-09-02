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
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          return
        }
        view.evaluateJavascript(
          "(function(){try{return !!(window.__tieHandleAndroidBack&&window.__tieHandleAndroidBack());}catch(e){return false;}})()",
          { result ->
            if (result == "true") {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
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
