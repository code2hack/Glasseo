package com.code2hack.glasseo

import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        trace("lifecycle", "create")
        root = FrameLayout(this).also { setContentView(it) }
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        configureWebView()
        webView.loadUrl(OriginPolicy.START_URL)
    }

    override fun onResume() {
        super.onResume()
        trace("lifecycle", "resume")
    }

    override fun onDestroy() {
        trace("lifecycle", "destroy")
        webView.destroy()
        super.onDestroy()
    }

    private fun configureWebView() {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
        }
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "Origin-restricted WebView message listener is unavailable"
        }
        WebViewCompat.addWebMessageListener(
            webView,
            "glasseoNative",
            setOf(OriginPolicy.APP_ORIGIN),
        ) { _, message, sourceOrigin, isMainFrame, _ ->
            if (!isMainFrame || sourceOrigin.toString() != OriginPolicy.APP_ORIGIN) {
                trace("bridge-rejected", sourceOrigin.toString())
                return@addWebMessageListener
            }
            runCatching { BridgeMessage.parse(message.data ?: "") }
                .onSuccess {
                    ProbeState.record(it)
                    val detail = if (it is BridgeMessage.ProbeResult) {
                        "passed=${it.passed} checks=${it.checks} details=${it.details} rendererGone=${ProbeState.rendererGone}"
                    } else {
                        it::class.simpleName ?: "message"
                    }
                    trace("bridge", detail)
                }
                .onFailure { trace("bridge-rejected", it.message ?: "invalid") }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame || OriginPolicy.allowsMainFrame(request.url.toString())) return false
                ProbeState.recordBlockedNavigation()
                trace("navigation-rejected", request.url.host ?: "unknown")
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                ProbeState.recordRendererGone()
                trace("renderer-gone", "crashed=${detail.didCrash()}")
                root.removeView(view)
                root.addView(TextView(this@MainActivity).apply {
                    setBackgroundColor(Color.BLACK)
                    setTextColor(Color.WHITE)
                    text = "Glasseo renderer stopped"
                    textSize = 22f
                })
                return true
            }
        }
    }

    private fun trace(event: String, detail: String) {
        Log.d("Glasseo", "t=${SystemClock.elapsedRealtimeNanos()} event=$event detail=$detail")
    }
}
