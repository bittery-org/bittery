package com.bittery.mobile

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Draws the web view under the status and navigation bars. `enableEdgeToEdge()` also picks
    // the bar glyph colour from the *system* night mode — but only once, here, and the manifest
    // lists `uiMode` in `android:configChanges`, so the activity is never recreated when that
    // changes. It is therefore a starting guess, not the source of truth; `SystemBars` below is.
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Lets the web app own the system bar appearance.
   *
   * The app's theme is chosen in JavaScript (`next-themes`, with an in-app Dark Mode switch), so
   * it can legitimately disagree with the system night mode. Nothing native can observe that
   * choice, and the result was dark status-bar glyphs sitting on our near-black dark canvas —
   * an invisible clock.
   *
   * A `@JavascriptInterface` rather than a Tauri plugin: a plugin is seven files of boilerplate
   * to carry one boolean, and `onWebViewCreate` is the extension point Wry exposes for exactly
   * this. The surface is one method that flips two window flags — it reads nothing and returns
   * nothing, so it grants a page no capability it did not already have.
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(SystemBars(), "BitterySystemBars")
  }

  private inner class SystemBars {
    @JavascriptInterface
    fun setDark(isDark: Boolean) {
      // Called from the web view's JS thread; window flags are main-thread only.
      runOnUiThread {
        WindowInsetsControllerCompat(window, window.decorView).apply {
          // "Light bars" means dark glyphs *for* a light background — so it is the inverse
          // of the app's theme, not the same as it.
          isAppearanceLightStatusBars = !isDark
          isAppearanceLightNavigationBars = !isDark
        }
      }
    }
  }
}
