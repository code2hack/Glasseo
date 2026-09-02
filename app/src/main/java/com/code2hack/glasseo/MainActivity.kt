package com.code2hack.glasseo

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
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
import androidx.webkit.WebMessageCompat

class MainActivity : Activity(), InputManager.InputDeviceListener {
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var inputManager: InputManager
    private lateinit var inputController: HudInputController
    private val handler = Handler(Looper.getMainLooper())
    private val longPressCheck = Runnable { emit(inputController.advance(SystemClock.uptimeMillis())); scheduleDeadline() }
    private val hidBindings = QualificationHidBindings()
    private val builtInBindings = BuiltInKeyBindings()
    private val externalDevices = mutableSetOf<Int>()
    private var webReady = false
    private val captureInput by lazy {
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 && intent.getBooleanExtra("input_capture", false)
    }
    private val consumeUnmapped by lazy { captureInput && intent.getBooleanExtra("consume_input", false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        trace("lifecycle", "create")
        root = FrameLayout(this).also { setContentView(it) }
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        inputController = HudInputController(onVisibilityChanged = { visible ->
            webView.visibility = if (visible) View.VISIBLE else View.INVISIBLE
            trace("hud", if (visible) "visible" else "hidden")
        })
        inputManager = getSystemService(Context.INPUT_SERVICE) as InputManager
        inputManager.inputDeviceIds.forEach(::rememberDevice)
        inputManager.registerInputDeviceListener(this, handler)
        configureWebView()
        webView.loadUrl(OriginPolicy.START_URL)
    }

    override fun onResume() {
        super.onResume()
        trace("lifecycle", "resume")
    }

    override fun onPause() {
        cancelInputs("pause")
        super.onPause()
    }

    override fun onStop() {
        cancelInputs("stop")
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        trace("focus", "hasFocus=$hasFocus")
        if (!hasFocus) cancelInputs("focus-loss")
    }

    override fun onDestroy() {
        handler.removeCallbacks(longPressCheck)
        inputManager.unregisterInputDeviceListener(this)
        cancelInputs("destroy")
        trace("lifecycle", "destroy")
        webView.destroy()
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val source = sourceFor(event.device)
        traceKey(event, source)
        val control = when (source) {
            PhysicalSource.HID -> if (captureInput) hidBindings.controlFor(event.keyCode) else null
            PhysicalSource.BUILT_IN -> builtInBindings.controlFor(event.keyCode)
            null -> null
        }
        if (source != null && control != null && handleKey(event, source, control)) return true
        return if (consumeUnmapped) true else super.dispatchKeyEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        traceMotion("touch", event)
        return if (consumeUnmapped) true else super.dispatchTouchEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        traceMotion("motion", event)
        return if (consumeUnmapped) true else super.dispatchGenericMotionEvent(event)
    }

    override fun onInputDeviceAdded(deviceId: Int) {
        rememberDevice(deviceId)
        traceDevice("input-device-added", deviceId)
    }

    override fun onInputDeviceChanged(deviceId: Int) {
        rememberDevice(deviceId)
        traceDevice("input-device-changed", deviceId)
    }

    override fun onInputDeviceRemoved(deviceId: Int) {
        val source = if (externalDevices.remove(deviceId)) PhysicalSource.HID else PhysicalSource.BUILT_IN
        emit(inputController.cancelSource(source, deviceId, SystemClock.uptimeMillis()))
        scheduleDeadline()
        trace("input-device-removed", "deviceId=$deviceId source=$source")
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
        check(WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)) {
            "Origin-targeted WebView messaging is unavailable"
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

            override fun onPageFinished(view: WebView, url: String) {
                webReady = OriginPolicy.allowsMainFrame(url)
                trace("page-finished", "trusted=$webReady")
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                webReady = false
                cancelInputs("renderer-gone")
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

    private fun handleKey(event: KeyEvent, source: PhysicalSource, control: SemanticControl): Boolean {
        val action = when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) PhysicalAction.DOWN else PhysicalAction.REPEAT
            KeyEvent.ACTION_UP -> PhysicalAction.UP
            else -> return false
        }
        emit(
            inputController.handle(
                PhysicalInput(PhysicalOwner(source, event.deviceId, event.keyCode), control, action, event.eventTime),
            ),
        )
        scheduleDeadline()
        return true
    }

    private fun emit(events: List<SemanticInteraction>) {
        events.forEach { event ->
            trace("semantic-input", "control=${event.control} action=${event.action} id=${event.interactionId}")
            if (!webReady) return@forEach
            WebViewCompat.postWebMessage(
                webView,
                WebMessageCompat(NativeSemanticMessage.encode(event)),
                Uri.parse(OriginPolicy.APP_ORIGIN),
            )
        }
    }

    internal fun emitForTest(event: SemanticInteraction) = emit(listOf(event))

    private fun scheduleDeadline() {
        handler.removeCallbacks(longPressCheck)
        inputController.nextDeadlineMillis?.let { handler.postAtTime(longPressCheck, it) }
    }

    private fun cancelInputs(reason: String) {
        if (!::inputController.isInitialized) return
        emit(inputController.cancelAll(SystemClock.uptimeMillis()))
        handler.removeCallbacks(longPressCheck)
        trace("input-cancel", reason)
    }

    private fun sourceFor(device: InputDevice?): PhysicalSource? = when {
        device == null || device.isVirtual -> null
        device.isExternal -> PhysicalSource.HID
        else -> PhysicalSource.BUILT_IN
    }

    private fun rememberDevice(deviceId: Int) {
        val device = inputManager.getInputDevice(deviceId) ?: return
        if (device.isExternal) externalDevices += deviceId else externalDevices -= deviceId
    }

    private fun traceKey(event: KeyEvent, source: PhysicalSource?) {
        if (!captureInput) return
        trace(
            "raw-key",
            "action=${event.action} keyCode=${event.keyCode} scanCode=${event.scanCode} " +
                "deviceId=${event.deviceId} source=${event.source} kind=$source repeat=${event.repeatCount} " +
                "eventTime=${event.eventTime} focus=${hasWindowFocus()}",
        )
    }

    private fun traceMotion(channel: String, event: MotionEvent) {
        if (!captureInput) return
        trace(
            "raw-$channel",
            "action=${event.actionMasked} pointers=${event.pointerCount} deviceId=${event.deviceId} " +
                "source=${event.source} eventTime=${event.eventTime} focus=${hasWindowFocus()}",
        )
    }

    private fun traceDevice(event: String, deviceId: Int) {
        if (!captureInput) return
        val device = inputManager.getInputDevice(deviceId)
        trace(
            event,
            "deviceId=$deviceId vendor=${device?.vendorId} product=${device?.productId} " +
                "sources=${device?.sources} external=${device?.isExternal}",
        )
    }

    private fun trace(event: String, detail: String) {
        Log.d("Glasseo", "t=${SystemClock.elapsedRealtimeNanos()} event=$event detail=$detail")
    }
}
