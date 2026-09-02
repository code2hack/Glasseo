package com.code2hack.glasseo

import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.graphics.Bitmap
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
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
    private val longPressCheck = Runnable {
        val now = SystemClock.uptimeMillis()
        hidQualificationCapture?.advance(now)
        emit(inputController.advance(now))
        scheduleDeadline()
    }
    private val finishBuiltInCapture = Runnable { finalizeBuiltInAttempt() }
    private val finishHidCapture = Runnable { finalizeHidAttempt() }
    private val externalDevices = mutableSetOf<Int>()
    private var hidQualificationCapture: HidQualificationCapture? = null
    private var builtInCapture: InputCapture? = null
    private var builtInFinalizerToken: QualificationFinalizerToken? = null
    private var hidFinalizerToken: QualificationFinalizerToken? = null
    private var attemptBrightness = -1
    private var attemptFocusLost = false
    private val attemptLifecycle = mutableSetOf<String>()
    private val attemptSideEffects = mutableSetOf<String>()
    private var abortAttempted = false
    private var nonOrderedBroadcastObserved = false
    private val nonOrderedBroadcastObservation by lazy {
        BroadcastInterception(this) { action, flags, ordered, aborted ->
            val capture = beginBuiltInAttempt() ?: return@BroadcastInterception
            capture.recordBroadcast(action, flags, ordered, SystemClock.uptimeMillis())
            abortAttempted = abortAttempted || aborted
            nonOrderedBroadcastObserved = nonOrderedBroadcastObserved || !ordered
            trace("qualification-broadcast", "action=$action flags=$flags ordered=$ordered abortAttempted=$aborted")
            scheduleBuiltInFinish()
        }
    }
    private val orderedBroadcastObserver: (OrderedBroadcastObservation) -> Unit = observer@ { observation ->
        val session = qualificationSession
        if (session?.mode == QualificationMode.BUILT_IN &&
            observation.action in GlasseoApplication.ORDERED_CONTROL_ACTIONS
        ) {
            if (session.snapshot.complete ||
                observation.action !in qualificationOrderedBroadcastActions(session.wizard.currentStep)
            ) {
                traceQualificationIgnored(session, "ordered-broadcast-step-mismatch-${observation.action}")
                return@observer
            }
            if (!session.armed) {
                traceQualificationIgnored(session, "ordered-broadcast-${observation.action}")
                return@observer
            }
            val capture = if (builtInCapture != null) builtInCapture else beginBuiltInAttempt()
            capture?.recordBroadcast(
                observation.action,
                observation.flags,
                observation.ordered,
                SystemClock.uptimeMillis(),
            )
            if (capture != null) {
                abortAttempted = abortAttempted || observation.abortAttempted
                scheduleBuiltInFinish()
            }
        }
    }
    private var webReady = false
    private val captureInput by lazy {
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0 && intent.getBooleanExtra("input_capture", false)
    }
    private val consumeUnmapped by lazy { captureInput && intent.getBooleanExtra("consume_input", false) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        trace("lifecycle", "create")
        glasseoApplication.observeOrderedBroadcasts(orderedBroadcastObserver)
        qualificationSession?.let { session ->
            session.suspendCapture()
            hidQualificationCapture = if (session.mode == QualificationMode.HID) HidQualificationCapture() else null
        }
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
        if (webReady) postQualificationState("resume")
    }

    override fun onPause() {
        recordQualificationLifecycle("pause")
        cancelInputs("pause")
        super.onPause()
    }

    override fun onStop() {
        recordQualificationLifecycle("stop")
        cancelInputs("stop")
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        trace("focus", "hasFocus=$hasFocus")
        if (!hasFocus) {
            if (builtInCapture != null) attemptFocusLost = true
            cancelInputs("focus-loss")
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(longPressCheck)
        handler.removeCallbacks(finishBuiltInCapture)
        handler.removeCallbacks(finishHidCapture)
        nonOrderedBroadcastObservation.end()
        glasseoApplication.stopObservingOrderedBroadcasts(orderedBroadcastObserver)
        inputManager.unregisterInputDeviceListener(this)
        cancelInputs("destroy")
        trace("lifecycle", "destroy")
        webView.destroy()
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val source = sourceFor(event.device)
        traceKey(event, source)
        if (captureInput && qualificationSession?.snapshot?.complete == false && source != null) {
            when (qualificationSession?.mode) {
                QualificationMode.HID -> if (source == PhysicalSource.HID) handleHidQualification(event)
                QualificationMode.BUILT_IN -> if (source == PhysicalSource.BUILT_IN) recordBuiltInKey(event)
                null -> Unit
            }
            return true
        }
        val control = when (source) {
            PhysicalSource.HID -> if (captureInput) glasseoApplication.hidBindings.controlFor(event.hidIdentity()) else null
            PhysicalSource.BUILT_IN -> null
            null -> null
        }
        if (source != null && control != null && handleKey(event, source, control)) return true
        return if (consumeUnmapped) true else super.dispatchKeyEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        traceMotion("touch", event)
        val physical = sourceFor(event.device) != null
        if (physical && captureInput && qualificationSession?.mode == QualificationMode.BUILT_IN &&
            qualificationSession?.snapshot?.complete == false
        ) {
            recordBuiltInMotion("touch", event)
            return true
        }
        return if (physical && consumeUnmapped) true else super.dispatchTouchEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        traceMotion("motion", event)
        val physical = sourceFor(event.device) != null
        if (physical && captureInput && qualificationSession?.mode == QualificationMode.BUILT_IN &&
            qualificationSession?.snapshot?.complete == false
        ) {
            recordBuiltInMotion("motion", event)
            return true
        }
        return if (physical && consumeUnmapped) true else super.dispatchGenericMotionEvent(event)
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
        hidQualificationCapture?.cancelSource(source, deviceId, SystemClock.uptimeMillis())
        if (source == PhysicalSource.HID && qualificationSession?.snapshot?.phase == QualificationPhase.AWAITING_CONFIRMATION) {
            qualificationSession?.cancelAttempt()
            publishQualificationMutation("disconnect")
        }
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
                    when (it) {
                        BridgeMessage.Hello -> postQualificationState("web-ready")
                        is BridgeMessage.QualificationStart -> if (captureInput) startQualification(it.mode)
                        is BridgeMessage.QualificationRendered -> acknowledgeQualificationRender(it)
                        else -> Unit
                    }
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
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                webReady = false
                qualificationSession?.suspendCapture()
                trace("page-started", "trusted=${OriginPolicy.allowsMainFrame(url)}")
            }

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
                if (webReady && (captureInput || qualificationSession != null)) {
                    val saved = getSharedPreferences(QUALIFICATION_PREFS, MODE_PRIVATE)
                        .getString(QUALIFICATION_CHECKPOINT, null)
                    if (qualificationSession == null && saved != null) {
                        runCatching { QualificationCheckpoint.decode(saved) }
                            .onSuccess(::restoreQualification)
                            .onFailure { clearQualificationCheckpoint() }
                    }
                    if (qualificationSession == null) {
                        postNative(NativeQualificationMessage.landing())
                        glasseoApplication.correlateWizardStep(null)
                    } else {
                        prepareQualificationStep()
                        postQualificationState("page-finished")
                    }
                }
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

    private fun startQualification(mode: QualificationMode) {
        clearQualificationCheckpoint()
        glasseoApplication.startQualification(mode)
        hidQualificationCapture = if (mode == QualificationMode.HID) HidQualificationCapture() else null
        prepareQualificationStep()
        publishQualificationMutation("start")
        trace("qualification-start", "mode=$mode")
    }

    private fun restoreQualification(checkpoint: QualificationCheckpoint) {
        glasseoApplication.restoreQualification(checkpoint)
        hidQualificationCapture = if (checkpoint.mode == QualificationMode.HID) HidQualificationCapture() else null
        prepareQualificationStep()
        publishQualificationMutation("restore")
        trace("qualification-resume", "mode=${checkpoint.mode} step=${checkpoint.step}")
    }

    private fun handleHidQualification(event: KeyEvent) {
        val session = qualificationSession ?: return
        if (session.snapshot.complete) return
        if (!session.armed) return traceQualificationIgnored(session, "hid-${event.action}")
        val action = event.physicalAction() ?: return
        val operation = hidQualificationCapture?.handle(
            PhysicalOwner(PhysicalSource.HID, event.deviceId, event.keyCode),
            event.hidIdentity(),
            session.wizard.currentStep.control,
            action,
            event.eventTime,
        )
        scheduleDeadline()
        if (operation != null) {
            when (val admission = session.capture(operation)) {
                is CaptureAdmission.Accepted -> {
                    hidFinalizerToken = admission.token
                    publishQualificationMutation("hid-captured")
                    handler.postAtTime(finishHidCapture, checkNotNull(session.snapshot.settleDeadlineMillis))
                }
                is CaptureAdmission.Ignored -> traceQualificationIgnored(session, admission.reason)
            }
        }
    }

    private fun finalizeHidAttempt() {
        val session = qualificationSession ?: return
        val token = hidFinalizerToken ?: return
        hidFinalizerToken = null
        val previousStep = session.wizard.currentStep
        if (!session.finalize(token)) return traceQualificationIgnored(session, "stale-finalizer")
        publishQualificationMutation("hid-finalized")
        if (session.snapshot.complete || session.wizard.currentStep != previousStep) prepareQualificationStep()
    }

    private fun recordBuiltInKey(event: KeyEvent) {
        val phase = when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) CapturedKeyPhase.DOWN else CapturedKeyPhase.REPEAT
            KeyEvent.ACTION_UP -> CapturedKeyPhase.UP
            else -> return
        }
        val capture = beginBuiltInAttempt() ?: return
        capture.recordKey(event.keyCode, event.scanCode, phase, event.eventTime)
        if (phase == CapturedKeyPhase.UP &&
            qualificationOrderedBroadcastActions(checkNotNull(qualificationSession).wizard.currentStep).isEmpty()
        ) {
            scheduleBuiltInFinish()
        }
    }

    private fun recordBuiltInMotion(channel: String, event: MotionEvent) {
        val capture = beginBuiltInAttempt() ?: return
        capture.recordMotion(
            channel,
            event.actionMasked,
            event.pointerCount,
            event.source,
            (0 until event.pointerCount).map(event::getX).average().toFloat(),
            (0 until event.pointerCount).map(event::getY).average().toFloat(),
            event.eventTime,
        )
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            scheduleBuiltInFinish()
        }
    }

    private fun beginBuiltInAttempt(): InputCapture? {
        val session = qualificationSession ?: return null
        if (!session.armed) {
            traceQualificationIgnored(session, "built-in-input")
            return null
        }
        builtInCapture?.let { return it }
        val step = session.wizard.currentStep
        attemptBrightness = Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1)
        attemptFocusLost = false
        attemptLifecycle.clear()
        attemptSideEffects.clear()
        abortAttempted = false
        nonOrderedBroadcastObserved = false
        return InputCapture(step.behavior).also { builtInCapture = it }
    }

    private fun scheduleBuiltInFinish() {
        if (builtInFinalizerToken != null) return
        val session = qualificationSession ?: return
        val capture = builtInCapture ?: return
        val preview = QualificationOperation(
            capture.finish(attemptFocusLost, attemptLifecycle.toSet(), attemptSideEffects.toSet()),
        )
        when (val admission = session.capture(preview)) {
            is CaptureAdmission.Accepted -> {
                builtInFinalizerToken = admission.token
                publishQualificationMutation("built-in-captured")
                handler.postAtTime(finishBuiltInCapture, checkNotNull(session.snapshot.settleDeadlineMillis))
            }
            is CaptureAdmission.Ignored -> traceQualificationIgnored(session, admission.reason)
        }
    }

    private fun finalizeBuiltInAttempt() {
        val capture = builtInCapture ?: return
        val session = qualificationSession ?: return
        val token = builtInFinalizerToken ?: return
        val previousStep = session.wizard.currentStep
        val brightness = Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1)
        if (attemptBrightness >= 0 && brightness != attemptBrightness) attemptSideEffects += "screen-brightness-changed"
        val signature = capture.finish(attemptFocusLost, attemptLifecycle.toSet(), attemptSideEffects.toSet())
        val suppression = when {
            nonOrderedBroadcastObserved || attemptSideEffects.isNotEmpty() -> SuppressionOutcome.FAILED
            abortAttempted -> SuppressionOutcome.SUCCEEDED
            else -> SuppressionOutcome.NOT_NEEDED
        }
        val operation = QualificationOperation(
            signature,
            deterministicDelivery = signature.keys.isNotEmpty() || signature.motions.isNotEmpty() ||
                signature.broadcasts.isNotEmpty(),
            unacceptableSideEffect = signature.focusLost || signature.lifecycleEffects.isNotEmpty() ||
                signature.systemSideEffects.isNotEmpty(),
            suppression = suppression,
        )
        builtInCapture = null
        builtInFinalizerToken = null
        if (!session.finalize(token, operation)) return traceQualificationIgnored(session, "stale-finalizer")
        trace(
            "qualification-operation",
            "step=$previousStep signature=$signature suppression=$suppression brightness=$brightness",
        )
        publishQualificationMutation("built-in-finalized")
        if (session.snapshot.complete || session.wizard.currentStep != previousStep) prepareQualificationStep()
    }

    private fun recordQualificationLifecycle(event: String) {
        if (builtInCapture == null) return
        attemptLifecycle += event
        cancelQualificationAttempt("lifecycle-$event")
    }

    private fun prepareQualificationStep() {
        nonOrderedBroadcastObservation.end()
        val session = qualificationSession ?: return
        val wizard = session.wizard
        if (session.snapshot.complete) {
            glasseoApplication.correlateWizardStep(null)
            clearQualificationCheckpoint()
            trace("qualification-matrix", "operations=${wizard.results} capabilities=${deriveCapabilities(wizard.results)}")
            return
        }
        glasseoApplication.correlateWizardStep(wizard.currentStep)
        if (session.mode == QualificationMode.BUILT_IN) {
            nonOrderedBroadcastObservation.begin(
                wizard.currentStep,
                qualificationNonOrderedBroadcastActions(wizard.currentStep),
            )
            if (wizard.currentStep == QualificationStep.LONG_COMMAND) {
                saveQualificationCheckpoint(wizard.checkpoint())
            } else {
                clearQualificationCheckpoint()
            }
        }
    }

    private fun saveQualificationCheckpoint(checkpoint: QualificationCheckpoint) {
        getSharedPreferences(QUALIFICATION_PREFS, MODE_PRIVATE).edit()
            .putString(QUALIFICATION_CHECKPOINT, checkpoint.encode())
            .apply()
        trace("qualification-checkpoint", "step=${checkpoint.step}")
    }

    private fun clearQualificationCheckpoint() {
        getSharedPreferences(QUALIFICATION_PREFS, MODE_PRIVATE).edit().remove(QUALIFICATION_CHECKPOINT).apply()
    }

    private fun qualificationOrderedBroadcastActions(step: QualificationStep): Set<String> = when (step) {
        QualificationStep.LONG_PRIMARY -> setOf("com.android.action.ACTION_AI_START")
        QualificationStep.SHORT_COMMAND -> setOf("com.android.action.ACTION_SPRITE_BUTTON_UP")
        QualificationStep.LONG_COMMAND -> setOf("com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS")
        else -> emptySet()
    }

    private fun qualificationNonOrderedBroadcastActions(step: QualificationStep): Set<String> = when (step) {
        QualificationStep.LONG_SECONDARY -> setOf("com.android.action.ACTION_SETTINGS_KEY")
        QualificationStep.DOUBLE_SECONDARY -> setOf("com.android.action.ACTION_KEYCODE_BACK")
        QualificationStep.LEFT -> setOf("com.android.action.ACTION_TWO_FINGER_SWIPE_BACK")
        QualificationStep.RIGHT -> setOf("com.android.action.ACTION_TWO_FINGER_SWIPE_FORWARD")
        else -> emptySet()
    }

    private fun publishQualificationMutation(reason: String) {
        val snapshot = qualificationSession?.snapshot ?: return
        trace("qualification-state-mutated", "reason=$reason ${snapshot.telemetry()}")
        postQualificationState(reason)
    }

    private fun postQualificationState(reason: String) {
        val snapshot = qualificationSession?.snapshot ?: return
        if (!webReady) return
        trace("qualification-state-sent", "reason=$reason ${snapshot.telemetry()}")
        postNative(NativeQualificationMessage.state(snapshot))
    }

    private fun acknowledgeQualificationRender(message: BridgeMessage.QualificationRendered) {
        val session = qualificationSession ?: return
        val ack = QualificationRenderAck(message.sessionId, message.revision, message.stepIndex, message.phase)
        val rendered = session.snapshot
        trace(
            "qualification-state-rendered",
            "renderedSessionId=${message.sessionId} renderedRevision=${message.revision} " +
                "renderedStep=${message.stepIndex} renderedPhase=${message.phase} current=${rendered.telemetry()}",
        )
        val result = session.acknowledge(ack)
        trace(
            "qualification-state-acked",
            "ackSessionId=${message.sessionId} ackRevision=${message.revision} ackStep=${message.stepIndex} " +
                "ackPhase=${message.phase} accepted=${result.accepted} current=${session.snapshot.telemetry()}",
        )
        if (result.snapshotChanged) {
            publishQualificationMutation("transition-rendered")
        } else if (result.armed) {
            trace("qualification-capture-armed", session.snapshot.telemetry())
        }
    }

    private fun traceQualificationIgnored(session: QualificationSession, reason: String) {
        trace("qualification-input-ignored", "reason=$reason ${session.snapshot.telemetry()}")
    }

    private fun postNative(message: String) {
        if (!webReady) return
        WebViewCompat.postWebMessage(
            webView,
            WebMessageCompat(message),
            Uri.parse(OriginPolicy.APP_ORIGIN),
        )
    }

    private fun KeyEvent.physicalAction(): PhysicalAction? = when (action) {
        KeyEvent.ACTION_DOWN -> if (repeatCount == 0) PhysicalAction.DOWN else PhysicalAction.REPEAT
        KeyEvent.ACTION_UP -> PhysicalAction.UP
        else -> null
    }

    private fun emit(events: List<SemanticInteraction>) {
        events.forEach { event ->
            trace("semantic-input", "control=${event.control} action=${event.action} id=${event.interactionId}")
            postNative(NativeSemanticMessage.encode(event))
        }
    }

    internal fun emitForTest(event: SemanticInteraction) = emit(listOf(event))

    internal fun startQualificationForTest(step: QualificationStep) {
        clearQualificationCheckpoint()
        glasseoApplication.startQualification(QualificationMode.BUILT_IN, step.ordinal)
        prepareQualificationStep()
        publishQualificationMutation("test-start")
    }

    internal fun submitQualificationForTest(operation: QualificationOperation): Boolean {
        val session = qualificationSession ?: return false
        val previousStep = session.wizard.currentStep
        val admission = session.capture(operation)
        if (admission !is CaptureAdmission.Accepted) return false
        publishQualificationMutation("test-captured")
        handler.postAtTime({
            if (session.finalize(admission.token)) {
                publishQualificationMutation("test-finalized")
                if (session.snapshot.complete || session.wizard.currentStep != previousStep) prepareQualificationStep()
            }
        }, checkNotNull(session.snapshot.settleDeadlineMillis))
        return true
    }

    internal fun reloadQualificationForTest() {
        qualificationSession?.suspendCapture()
        webView.reload()
    }

    internal fun readQualificationDomForTest(callback: (String) -> Unit) {
        webView.evaluateJavascript(
            "document.querySelector('h1').textContent + '|' + " +
                "document.querySelector('.qualification-prompt').textContent",
            callback,
        )
    }

    private fun scheduleDeadline() {
        handler.removeCallbacks(longPressCheck)
        listOfNotNull(inputController.nextDeadlineMillis, hidQualificationCapture?.nextDeadlineMillis)
            .minOrNull()
            ?.let { handler.postAtTime(longPressCheck, it) }
    }

    private fun cancelInputs(reason: String) {
        if (!::inputController.isInitialized) return
        val now = SystemClock.uptimeMillis()
        emit(inputController.cancelAll(now))
        hidQualificationCapture?.cancelAll(now)
        val session = qualificationSession
        if (session != null) {
            if (builtInCapture != null || session.hasPendingOperation) {
                cancelQualificationAttempt(reason)
            } else {
                session.suspendCapture()
            }
        }
        handler.removeCallbacks(longPressCheck)
        trace("input-cancel", reason)
    }

    private fun sourceFor(device: InputDevice?): PhysicalSource? = when {
        device == null || device.isVirtual -> null
        device.isExternal -> PhysicalSource.HID
        else -> PhysicalSource.BUILT_IN
    }

    private val glasseoApplication: GlasseoApplication
        get() = application as GlasseoApplication

    private val qualificationSession: QualificationSession?
        get() = glasseoApplication.qualificationSession

    private fun cancelQualificationAttempt(reason: String) {
        val session = qualificationSession ?: return
        handler.removeCallbacks(finishBuiltInCapture)
        handler.removeCallbacks(finishHidCapture)
        builtInCapture = null
        builtInFinalizerToken = null
        hidFinalizerToken = null
        session.cancelAttempt()
        publishQualificationMutation("cancel-$reason")
    }

    private fun QualificationSnapshot.telemetry() =
        "sessionId=$sessionId revision=$revision step=${step.name} phase=$phase attempt=$attempt " +
            "operationId=$operationId armed=${qualificationSession?.armed}"

    private fun KeyEvent.hidIdentity(): HidPhysicalIdentity {
        val inputDevice = device
        return HidPhysicalIdentity(
            inputDevice?.descriptor.orEmpty(),
            inputDevice?.vendorId ?: 0,
            inputDevice?.productId ?: 0,
            keyCode,
            scanCode,
        )
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

    companion object {
        private const val QUALIFICATION_PREFS = "debug-input-qualification"
        private const val QUALIFICATION_CHECKPOINT = "long-command-checkpoint"
    }
}
