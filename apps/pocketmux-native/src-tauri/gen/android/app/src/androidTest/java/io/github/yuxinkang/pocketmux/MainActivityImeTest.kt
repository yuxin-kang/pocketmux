package io.github.yuxinkang.pocketmux

import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.pressBack
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MainActivityImeTest {
  @Test
  fun remoteFrameCannotCallPrivilegedNativeCommandsWithoutTheShellSession() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      val webView = waitForWebView(scenario)
      waitForJavaScript(webView, "document.readyState === 'complete'") { it == "true" }
      waitForJavaScript(webView, "Boolean(window.__TAURI__?.core?.invoke)") { it == "true" }

      evaluateJavaScript(
        webView,
        """
          (() => {
            const frame = document.createElement('iframe');
            frame.id = 'hostile-frame';
            frame.src = 'about:blank';
            document.body.append(frame);
            return true;
          })()
        """.trimIndent(),
      )
      waitForJavaScript(
        webView,
        "Boolean(document.querySelector('#hostile-frame')?.contentWindow?.__TAURI__?.core?.invoke)",
      ) { it == "true" }

      evaluateJavaScript(
        webView,
        """
          (() => {
            window.__hostileFrameResult = 'pending';
            const invoke = document.querySelector('#hostile-frame').contentWindow.__TAURI__.core.invoke;
            invoke('get_connection_tokens', {
              serverUrls: [],
              sessionToken: '0'.repeat(64),
            }).then(
              () => { window.__hostileFrameResult = 'allowed'; },
              () => { window.__hostileFrameResult = 'rejected'; },
            );
            return true;
          })()
        """.trimIndent(),
      )
      waitForJavaScript(webView, "window.__hostileFrameResult") { it == "\"rejected\"" }
    }
  }

  @Test
  fun remoteComposerRemainsInsideTheVisualViewportWhileImeIsVisible() {
    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
      val webView = waitForWebView(scenario)
      waitForJavaScript(webView, "document.readyState === 'complete'") { it == "true" }

      evaluateJavaScript(
        webView,
        """
          (() => {
            const appFrame = document.querySelector('.app-frame');
            const frame = document.querySelector('#remote-frame');
            document.querySelector('#launcher').classList.add('is-hidden');
            document.querySelector('#app-footer').classList.add('is-hidden');
            document.querySelector('#remote-shell').classList.remove('is-hidden');
            appFrame.classList.add('is-remote');
            frame.srcdoc = '<textarea id="composer" style="position:fixed;left:8px;right:8px;bottom:8px;height:56px"></textarea>';
            return true;
          })()
        """.trimIndent(),
      )
      waitForJavaScript(webView, "Boolean(document.querySelector('#remote-frame')?.contentDocument?.querySelector('#composer'))") {
        it == "true"
      }

      val initialFrameBottom = evaluateDouble(
        webView,
        "document.querySelector('#remote-frame').getBoundingClientRect().bottom",
      )
      evaluateJavaScript(
        webView,
        "document.querySelector('#remote-frame').contentDocument.querySelector('#composer').focus(); true",
      )
      scenario.onActivity { activity ->
        webView.requestFocus()
        activity.getSystemService(InputMethodManager::class.java)
          .showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
      }

      val frameBottom = waitForDouble(
        webView,
        "document.querySelector('#remote-frame').getBoundingClientRect().bottom",
      ) { it <= initialFrameBottom - 100 }
      val nativeViewportHeight = waitForDouble(
        webView,
        "Number(window.__POCKETMUX_NATIVE_VIEWPORT__?.height || 0)",
      ) { it > 0 }
      val composerBottom = evaluateDouble(
        webView,
        """
          (() => {
            const frame = document.querySelector('#remote-frame');
            const composer = frame.contentDocument.querySelector('#composer');
            return frame.getBoundingClientRect().top + composer.getBoundingClientRect().bottom;
          })()
        """.trimIndent(),
      )
      assertTrue("remote frame is hidden behind the IME", frameBottom <= nativeViewportHeight + 3)
      assertTrue("composer is hidden behind the IME", composerBottom <= frameBottom + 2)

      pressBack()
      waitForDouble(webView, "document.querySelector('#remote-frame').getBoundingClientRect().bottom") {
        it >= initialFrameBottom - 2
      }
    }
  }

  private fun waitForWebView(scenario: ActivityScenario<MainActivity>): WebView {
    repeat(100) {
      var found: WebView? = null
      scenario.onActivity { activity -> found = findWebView(activity.window.decorView) }
      if (found != null) return found!!
      Thread.sleep(50)
    }
    throw AssertionError("Pocketmux WebView was not created")
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private fun waitForJavaScript(webView: WebView, script: String, predicate: (String) -> Boolean): String {
    repeat(100) {
      val value = evaluateJavaScript(webView, script)
      if (predicate(value)) return value
      Thread.sleep(50)
    }
    throw AssertionError("JavaScript condition did not become true: $script")
  }

  private fun waitForDouble(webView: WebView, script: String, predicate: (Double) -> Boolean): Double {
    repeat(100) {
      val value = evaluateDouble(webView, script)
      if (predicate(value)) return value
      Thread.sleep(50)
    }
    throw AssertionError("JavaScript value did not reach the expected state: $script")
  }

  private fun evaluateDouble(webView: WebView, script: String): Double =
    evaluateJavaScript(webView, script).toDouble()

  private fun evaluateJavaScript(webView: WebView, script: String): String {
    val completed = CountDownLatch(1)
    var result = "null"
    webView.post {
      webView.evaluateJavascript(script) { value ->
        result = value
        completed.countDown()
      }
    }
    assertTrue("JavaScript evaluation timed out", completed.await(5, TimeUnit.SECONDS))
    return result
  }
}
