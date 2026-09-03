package com.code2hack.glasseo

import android.app.Application
import android.os.SystemClock
import android.util.Log
import java.util.UUID

class GlasseoApplication : Application() {
    private val observers = mutableSetOf<(OrderedBroadcastObservation) -> Unit>()
    private var wizardStep: QualificationStep? = null

    internal lateinit var orderedInterception: PersistentOrderedBroadcastInterception
        private set
    val hidBindings = HidBindingMap()
    val hidInputTrace = HidInputTraceRecorder()
    lateinit var hidBindingStore: HidBindingStore
        private set
    lateinit var hidBindingCapture: HidBindingCapture
        private set
    var qualificationSession: QualificationSession? = null
        private set
    var hidQualificationFlow: HidQualificationFlow? = null
        private set

    override fun onCreate() {
        super.onCreate()
        val persistence = SharedPreferencesHidBindingPersistence(
            getSharedPreferences(HID_BINDING_PREFS, MODE_PRIVATE),
        )
        hidBindingStore = HidBindingStore(persistence.read(), persistence, System::currentTimeMillis)
        hidBindingCapture = HidBindingCapture(hidBindingStore)
        orderedInterception = PersistentOrderedBroadcastInterception(
            this,
            ORDERED_CONTROL_ACTIONS,
            { wizardStep },
        ) { observation -> observers.toList().forEach { it(observation) } }
        orderedInterception.start()
        Log.d(
            "Glasseo",
            "t=${SystemClock.elapsedRealtimeNanos()} event=ordered-broadcast-registration " +
                "detail=actions=${ORDERED_CONTROL_ACTIONS.sorted().joinToString(",")}",
        )
    }

    fun observeOrderedBroadcasts(observer: (OrderedBroadcastObservation) -> Unit) {
        observers += observer
    }

    fun stopObservingOrderedBroadcasts(observer: (OrderedBroadcastObservation) -> Unit) {
        observers -= observer
    }

    fun correlateWizardStep(step: QualificationStep?) {
        wizardStep = step
    }

    fun startQualification(
        mode: QualificationMode,
        startIndex: Int = 0,
        pauseAt: QualificationPauseTarget? = null,
    ): QualificationSession = newQualification(mode, startIndex, emptyMap(), pauseAt)

    fun startHidQualification(peripheral: HidPeripheralIdentity): HidQualificationFlow {
        qualificationSession = null
        hidBindings.clear()
        return HidQualificationFlow(UUID.randomUUID().toString(), peripheral, hidBindings).also {
            hidQualificationFlow = it
        }
    }

    fun restoreQualification(
        checkpoint: QualificationCheckpoint,
        pauseAt: QualificationPauseTarget? = null,
    ): QualificationSession = newQualification(
        checkpoint.mode,
        checkpoint.stepIndex,
        checkpoint.results,
        pauseAt,
    )

    private fun newQualification(
        mode: QualificationMode,
        startIndex: Int,
        initialResults: Map<QualificationStep, OperationResult>,
        pauseAt: QualificationPauseTarget?,
    ): QualificationSession = QualificationSession(
        mode = mode,
        sessionId = UUID.randomUUID().toString(),
        bindings = hidBindings,
        startIndex = startIndex,
        initialResults = if (mode == QualificationMode.BUILT_IN) {
            ACCEPTED_BUILT_IN_OPERATION_RESULTS + initialResults
        } else {
            initialResults
        },
        nowMillis = SystemClock::uptimeMillis,
        pauseAt = pauseAt,
    ).also {
        hidQualificationFlow = null
        qualificationSession = it
    }

    companion object {
        private const val HID_BINDING_PREFS = "hid-bindings"
        val ORDERED_CONTROL_ACTIONS = setOf(
            "com.android.action.ACTION_AI_START",
            "com.android.action.ACTION_SPRITE_BUTTON_UP",
            "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS",
        )
    }
}
