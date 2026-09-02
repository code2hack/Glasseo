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
    var qualificationSession: QualificationSession? = null
        private set

    override fun onCreate() {
        super.onCreate()
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

    fun startQualification(mode: QualificationMode, startIndex: Int = 0): QualificationSession = QualificationSession(
        mode,
        UUID.randomUUID().toString(),
        hidBindings,
        startIndex,
        nowMillis = SystemClock::uptimeMillis,
    ).also { qualificationSession = it }

    fun restoreQualification(checkpoint: QualificationCheckpoint): QualificationSession = QualificationSession(
        checkpoint.mode,
        UUID.randomUUID().toString(),
        hidBindings,
        checkpoint.stepIndex,
        checkpoint.results,
        SystemClock::uptimeMillis,
    ).also { qualificationSession = it }

    companion object {
        val ORDERED_CONTROL_ACTIONS = setOf(
            "com.android.action.ACTION_AI_START",
            "com.android.action.ACTION_SPRITE_BUTTON_UP",
            "com.android.action.ACTION_SPRITE_BUTTON_LONG_PRESS",
        )
    }
}
