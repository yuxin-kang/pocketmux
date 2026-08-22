package io.github.yuxinkang.pocketmux

import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var lastPublishedViewport: Pair<Int, Int>? = null
  private var activeWebView: WebView? = null
  private var activityDestroyed = false
  private val pocketmuxFileBridge = PocketmuxFileBridge()

  override fun onCreate(savedInstanceState: Bundle?) {
    activityDestroyed = false
    // android-native-keyring-store obtains the Android application context
    // through ndk-context. Initialize it before Tauri can issue any keyring
    // command (including the startup credential hydrate).
    io.crates.keyring.Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.rgb(16, 17, 20))
  }

  override fun onDestroy() {
    activityDestroyed = true
    activeWebView = null
    lastPublishedViewport = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    activeWebView = webView
    lastPublishedViewport = null
    webView.setBackgroundColor(Color.rgb(16, 17, 20))
    webView.addJavascriptInterface(pocketmuxFileBridge, "PocketmuxFiles")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val handledTypes =
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val safeArea = windowInsets.getInsets(handledTypes)
      val imeBottom = windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val layoutParams = view.layoutParams as? ViewGroup.MarginLayoutParams
      if (layoutParams != null && (
          layoutParams.leftMargin != safeArea.left ||
          layoutParams.topMargin != safeArea.top ||
          layoutParams.rightMargin != safeArea.right ||
          layoutParams.bottomMargin != safeArea.bottom
        )) {
        layoutParams.setMargins(safeArea.left, safeArea.top, safeArea.right, safeArea.bottom)
        view.layoutParams = layoutParams
      }
      publishVisibleViewport(webView, imeBottom)
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes, Insets.NONE)
        .build()
    }
    webView.post { ViewCompat.requestApplyInsets(webView) }
  }

  private inner class PocketmuxFileBridge {
    @JavascriptInterface
    fun saveFile(
      sessionToken: String,
      base64Data: String,
      displayName: String,
      contentType: String,
      openAfterSave: Boolean,
    ): String {
      if (!sessionToken.matches(Regex("[a-fA-F0-9]{64}"))) {
        return bridgeResult(false, "invalid-capability")
      }
      if (base64Data.length > 70_000_000) {
        return bridgeResult(false, "file-too-large")
      }
      val normalizedType = when (contentType.lowercase()) {
        "application/pdf" -> "application/pdf"
        "image/jpeg" -> "image/jpeg"
        "image/png" -> "image/png"
        "image/gif" -> "image/gif"
        "image/webp" -> "image/webp"
        "image/avif" -> "image/avif"
        "image/heic" -> "image/heic"
        "image/heif" -> "image/heif"
        "image/bmp" -> "image/bmp"
        "image/tiff" -> "image/tiff"
        "video/mp4" -> "video/mp4"
        "video/x-m4v" -> "video/x-m4v"
        "video/quicktime" -> "video/quicktime"
        "video/webm" -> "video/webm"
        "video/x-matroska" -> "video/x-matroska"
        "video/x-msvideo" -> "video/x-msvideo"
        "video/3gpp" -> "video/3gpp"
        "video/mpeg" -> "video/mpeg"
        "video/x-ms-wmv" -> "video/x-ms-wmv"
        "video/ogg" -> "video/ogg"
        "text/markdown" -> "text/markdown"
        "text/plain" -> "text/plain"
        else -> return bridgeResult(false, "unsupported-file-type")
      }
      return try {
        val bytes = Base64.decode(base64Data, Base64.DEFAULT)
        if (bytes.isEmpty() || bytes.size > 50 * 1024 * 1024) {
          return bridgeResult(false, "invalid-file-data")
        }
        val safeName = sanitizeFileName(displayName)
        val uri = writeFile(bytes, safeName, normalizedType)
        if (openAfterSave) {
          val openIntent = createOpenIntent(uri, normalizedType)
          if (openIntent.resolveActivity(packageManager) == null) {
            return bridgeResult(false, "saved-no-viewer")
          }
          runOnUiThread { openFile(openIntent) }
        }
        bridgeResult(true, if (openAfterSave) "opened" else "saved")
      } catch (error: Exception) {
        Log.e("PocketmuxFiles", "Unable to save inbox file", error)
        bridgeResult(false, "native-file-save-failed")
      }
    }
  }

  private fun bridgeResult(ok: Boolean, code: String): String {
    return "{\"ok\":$ok,\"code\":\"$code\"}"
  }

  private fun sanitizeFileName(value: String): String {
    val sanitized = value
      .replace(Regex("[\\\\/\\u0000-\\u001f\\u007f]"), "_")
      .trim()
      .take(180)
    return sanitized.ifEmpty { "pocketmux-file" }
  }

  private fun writeFile(bytes: ByteArray, displayName: String, contentType: String): Uri {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val resolver = contentResolver
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, contentType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Pocketmux")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: error("Unable to create a Downloads entry")
      try {
        resolver.openOutputStream(uri)?.use { output -> output.write(bytes) }
          ?: error("Unable to open the Downloads entry")
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        return uri
      } catch (error: Exception) {
        resolver.delete(uri, null, null)
        throw error
      }
    }

    val directory = File(cacheDir, "pocketmux-files").apply { mkdirs() }
    val file = File(directory, displayName)
    file.writeBytes(bytes)
    return FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
  }

  private fun createOpenIntent(uri: Uri, contentType: String): Intent {
    return Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, contentType)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  }

  private fun openFile(intent: Intent) {
    try {
      startActivity(Intent.createChooser(intent, "Open with"))
    } catch (error: Exception) {
      Log.e("PocketmuxFiles", "No application can open inbox file", error)
    }
  }

  private fun publishVisibleViewport(webView: WebView, imeBottom: Int) {
    if (activityDestroyed || activeWebView !== webView || !webView.isAttachedToWindow) return
    webView.post {
      if (activityDestroyed || activeWebView !== webView || !webView.isAttachedToWindow) return@post
      try {
        val webViewHeight = webView.height
        val rootView = webView.rootView
        if (webViewHeight <= 0 || rootView.height <= 0 || webView.url == null) return@post

        val webViewLocation = IntArray(2)
        val rootLocation = IntArray(2)
        webView.getLocationInWindow(webViewLocation)
        rootView.getLocationInWindow(rootLocation)
        val rootBottom = rootLocation[1] + rootView.height
        val imeTop = rootBottom - imeBottom.coerceAtLeast(0)
        val visibleHeight = (imeTop - webViewLocation[1]).coerceIn(0, webViewHeight)
        val density = webView.resources.displayMetrics.density.coerceAtLeast(1f)
        val heightCssPixels = (visibleHeight / density).roundToInt().coerceAtLeast(1)
        val insetCssPixels = ((webViewHeight - visibleHeight) / density).roundToInt().coerceAtLeast(0)
        val viewport = heightCssPixels to insetCssPixels
        if (viewport == lastPublishedViewport) return@post

        webView.evaluateJavascript(
          """
            (() => {
              const viewport = Object.freeze({ height: $heightCssPixels, inset: $insetCssPixels });
              window.__POCKETMUX_NATIVE_VIEWPORT__ = viewport;
              window.dispatchEvent(new CustomEvent('pocketmux:native-viewport', { detail: viewport }));
            })();
          """.trimIndent(),
          null,
        )
        lastPublishedViewport = viewport
      } catch (_: RuntimeException) {
        // Insets can arrive while Tauri is replacing or destroying the WebView.
        // A stale viewport update must never terminate the Android process.
        lastPublishedViewport = null
      }
    }
  }
}
