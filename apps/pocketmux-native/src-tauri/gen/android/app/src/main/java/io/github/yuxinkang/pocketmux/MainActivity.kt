package io.github.yuxinkang.pocketmux

import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var lastPublishedViewport: Pair<Int, Int>? = null
  private var activeWebView: WebView? = null
  private var activityDestroyed = false

  override fun onCreate(savedInstanceState: Bundle?) {
    activityDestroyed = false
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
