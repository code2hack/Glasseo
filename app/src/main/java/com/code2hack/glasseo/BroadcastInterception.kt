package com.code2hack.glasseo

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import android.util.Log

data class BroadcastDecision(val observed: Boolean, val abortAttempted: Boolean)

data class OrderedBroadcastObservation(
    val action: String,
    val flags: Int,
    val ordered: Boolean,
    val observed: Boolean,
    val abortAttempted: Boolean,
    val wizardStep: QualificationStep?,
)

class PersistentOrderedBroadcastState(
    private val actions: Set<String>,
    private val noAbortFlag: Int = Intent.FLAG_RECEIVER_NO_ABORT,
) {
    var initialized = false
        private set

    fun initialize(): Boolean {
        if (initialized) return false
        initialized = true
        return true
    }

    fun receive(
        action: String,
        flags: Int,
        ordered: Boolean,
        wizardStep: QualificationStep?,
    ): OrderedBroadcastObservation? {
        if (!initialized) return null
        val observed = action in actions
        return OrderedBroadcastObservation(
            action,
            flags,
            ordered,
            observed,
            observed && ordered && flags and noAbortFlag == 0,
            wizardStep,
        )
    }
}

class PersistentOrderedBroadcastInterception(
    private val context: Context,
    actions: Set<String>,
    private val wizardStep: () -> QualificationStep?,
    private val onObserved: (OrderedBroadcastObservation) -> Unit,
) {
    private val state = PersistentOrderedBroadcastState(actions)
    private val filter = IntentFilter().apply {
        actions.forEach(::addAction)
        priority = Int.MAX_VALUE
    }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val action = intent.action ?: return
            val observation = state.receive(action, intent.flags, isOrderedBroadcast, wizardStep()) ?: return
            if (!observation.observed) return
            if (observation.abortAttempted) {
                setResult(Activity.RESULT_CANCELED, null, null)
                abortBroadcast()
            }
            Log.d(
                "Glasseo",
                "t=${SystemClock.elapsedRealtimeNanos()} event=ordered-broadcast-interception " +
                    "detail=action=$action flags=${intent.flags} ordered=$isOrderedBroadcast " +
                    "abortAttempted=${observation.abortAttempted} resultCode=$resultCode " +
                    "wizardStep=${observation.wizardStep}",
            )
            onObserved(observation)
        }
    }

    val started: Boolean
        get() = state.initialized

    fun start() {
        if (started) return
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
        state.initialize()
    }
}

class BroadcastInterceptionState(private val noAbortFlag: Int = Intent.FLAG_RECEIVER_NO_ABORT) {
    var registered: Boolean = false
        private set
    var actions: Set<String> = emptySet()
        private set
    var step: QualificationStep? = null
        private set

    fun begin(step: QualificationStep, actions: Set<String>) {
        this.step = step
        this.actions = actions
        registered = actions.isNotEmpty()
    }

    fun receive(action: String, flags: Int, ordered: Boolean): BroadcastDecision {
        val observed = registered && action in actions
        return BroadcastDecision(observed, observed && ordered && flags and noAbortFlag == 0)
    }

    fun end() {
        registered = false
        actions = emptySet()
        step = null
    }
}

class BroadcastInterception(
    private val context: Context,
    private val onObserved: (action: String, flags: Int, ordered: Boolean, abortAttempted: Boolean) -> Unit,
) {
    private val state = BroadcastInterceptionState()
    private var receiver: BroadcastReceiver? = null

    fun begin(step: QualificationStep, actions: Set<String>) {
        end()
        state.begin(step, actions)
        if (!state.registered) return
        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val action = intent.action ?: return
                val decision = state.receive(action, intent.flags, isOrderedBroadcast)
                if (!decision.observed) return
                onObserved(action, intent.flags, isOrderedBroadcast, decision.abortAttempted)
                if (decision.abortAttempted) {
                    setResult(Activity.RESULT_CANCELED, null, null)
                    abortBroadcast()
                }
            }
        }.also { registeredReceiver ->
            val filter = IntentFilter().apply {
                actions.forEach(::addAction)
                priority = Int.MAX_VALUE
            }
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(registeredReceiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                context.registerReceiver(registeredReceiver, filter)
            }
        }
    }

    fun end() {
        receiver?.let(context::unregisterReceiver)
        receiver = null
        state.end()
    }
}
