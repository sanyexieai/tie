package com.tie.knowledge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File

object SafBridge {
  private const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR

  @JvmStatic
  fun exists(context: Context, uri: String): Boolean {
    val parsed = parse(uri) ?: return false
    return try {
      query(context, documentUri(parsed), arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID))
        ?: query(context, parsed, arrayOf(OpenableColumns.DISPLAY_NAME))
        ?: false
    } catch (_: Exception) {
      false
    }
  }

  @JvmStatic
  fun isDirectory(context: Context, uri: String): Boolean {
    val parsed = parse(uri) ?: return false
    if (DocumentsContract.isTreeUri(parsed) && !DocumentsContract.isDocumentUri(context, parsed)) {
      return true
    }
    return mime(context, uri) == MIME_DIR
  }

  @JvmStatic
  fun size(context: Context, uri: String): Long {
    if (isDirectory(context, uri)) return 0
    val parsed = parse(uri) ?: return 0
    return try {
      context.contentResolver.query(parsed, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use 0L
        val index = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (index < 0 || cursor.isNull(index)) 0L else cursor.getLong(index)
      } ?: 0L
    } catch (_: Exception) {
      0L
    }
  }

  @JvmStatic
  fun displayName(context: Context, uri: String): String {
    val parsed = parse(uri) ?: return "document"
    return try {
      context.contentResolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use fallbackName(parsed)
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index < 0) fallbackName(parsed) else cursor.getString(index)?.ifBlank { fallbackName(parsed) } ?: fallbackName(parsed)
      } ?: fallbackName(parsed)
    } catch (_: Exception) {
      fallbackName(parsed)
    }
  }

  @JvmStatic
  fun mime(context: Context, uri: String): String {
    val parsed = parse(uri) ?: return "application/octet-stream"
    if (DocumentsContract.isTreeUri(parsed) && !DocumentsContract.isDocumentUri(context, parsed)) {
      return MIME_DIR
    }
    return try {
      context.contentResolver.getType(parsed)?.ifBlank { "application/octet-stream" }
        ?: "application/octet-stream"
    } catch (_: Exception) {
      "application/octet-stream"
    }
  }

  @JvmStatic
  fun readToPath(context: Context, uri: String, destPath: String) {
    val parsed = parse(uri) ?: throw IllegalArgumentException("无效的 content URI")
    if (isDirectory(context, uri)) {
      throw IllegalArgumentException("不能读取目录内容")
    }
    val dest = File(destPath)
    dest.parentFile?.mkdirs()
    context.contentResolver.openInputStream(parsed)?.use { input ->
      dest.outputStream().use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("无法打开文档")
  }

  @JvmStatic
  fun open(context: Context, uri: String) {
    val parsed = parse(uri) ?: throw IllegalArgumentException("无效的 content URI")
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(parsed, mime(context, uri).ifBlank { "*/*" })
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(Intent.createChooser(intent, displayName(context, uri)))
  }

  @JvmStatic
  fun persistRead(context: Context, uri: String) {
    val parsed = parse(uri) ?: return
    try {
      context.contentResolver.takePersistableUriPermission(
        parsed,
        Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    } catch (_: SecurityException) {
      // 部分提供方不支持持久权限；本次会话内仍可读写。
    }
  }

  private fun parse(uri: String): Uri? {
    val trimmed = uri.trim()
    if (!trimmed.startsWith("content://")) return null
    return Uri.parse(trimmed)
  }

  private fun documentUri(uri: Uri): Uri {
    return if (DocumentsContract.isTreeUri(uri) && DocumentsContract.getTreeDocumentId(uri) != null) {
      DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
    } else {
      uri
    }
  }

  private fun query(context: Context, uri: Uri, columns: Array<String>): Boolean? {
    return context.contentResolver.query(uri, columns, null, null, null)?.use { it.count > 0 }
  }

  private fun fallbackName(uri: Uri): String {
    return uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')?.ifBlank { "document" }
      ?: "document"
  }
}
