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

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.rgb(16, 17, 20))
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(Color.rgb(16, 17, 20))
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val handledTypes =
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val safeArea = windowInsets.getInsets(handledTypes)
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
      WindowInsetsCompat.Builder(windowInsets)
        .setInsets(handledTypes, Insets.NONE)
        .build()
    }
    webView.post { ViewCompat.requestApplyInsets(webView) }
  }
}
