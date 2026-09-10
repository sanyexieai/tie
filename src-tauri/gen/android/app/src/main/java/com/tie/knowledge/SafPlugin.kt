package com.tie.knowledge

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SafPickArgs {
  var kind: String = "file"
}

@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun pick(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(SafPickArgs::class.java)
      val directory = args.kind == "directory"
      val intent = if (directory) {
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      } else {
        Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
          addCategory(Intent.CATEGORY_OPENABLE)
          type = "*/*"
        }
      }
      intent.addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
      startActivityForResult(invoke, intent, "pickResult")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法打开系统文档选择器")
    }
  }

  @ActivityCallback
  fun pickResult(invoke: Invoke, result: ActivityResult) {
    try {
      if (result.resultCode != Activity.RESULT_OK) {
        invoke.resolve(emptyPick())
        return
      }
      val uri: Uri? = result.data?.data
      if (uri == null) {
        invoke.resolve(emptyPick())
        return
      }
      SafBridge.persistRead(activity, uri.toString())
      val kind = if (DocumentsContract.isTreeUri(uri) || SafBridge.isDirectory(activity, uri.toString())) {
        "directory"
      } else {
        "file"
      }
      val payload = JSObject()
      payload.put("uri", uri.toString())
      payload.put("name", SafBridge.displayName(activity, uri.toString()))
      payload.put("mime", SafBridge.mime(activity, uri.toString()))
      payload.put("size", SafBridge.size(activity, uri.toString()))
      payload.put("kind", kind)
      payload.put("cancelled", false)
      invoke.resolve(payload)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "无法读取所选文档")
    }
  }

  private fun emptyPick(): JSObject {
    val payload = JSObject()
    payload.put("uri", "")
    payload.put("name", "")
    payload.put("mime", "")
    payload.put("size", 0)
    payload.put("kind", "file")
    payload.put("cancelled", true)
    return payload
  }
}
