package com.code2hack.glasseo

data class HidPressTiming(val downAtMillis: Long, val upAtMillis: Long)

data class HidCaptureResult(
    val operation: QualificationOperation? = null,
    val reason: String,
)

class HidQualificationCapture(private val timing: InputTiming = InputTiming()) {
    private data class ActivePress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val downAtMillis: Long,
        val releaseToNextDownMillis: Long?,
    )

    private data class PendingSecondaryPress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val timing: HidPressTiming,
    )

    private var activePress: ActivePress? = null
    private var pendingSecondaryPress: PendingSecondaryPress? = null
    private var longObserved = false
    private val classifier = InputClassifier(timing)

    val nextDeadlineMillis: Long?
        get() = listOfNotNull(
            classifier.nextDeadlineMillis,
            pendingSecondaryPress?.timing?.upAtMillis?.plus(timing.doublePressMillis + 1),
        ).minOrNull()

    val hasActivePress: Boolean
        get() = activePress != null

    val hasPendingInput: Boolean
        get() = activePress != null || pendingSecondaryPress != null

    fun handle(
        owner: PhysicalOwner,
        identity: HidPhysicalIdentity,
        control: SemanticControl,
        action: PhysicalAction,
        timeMillis: Long,
    ): QualificationOperation? = handleDetailed(owner, identity, control, action, timeMillis).operation

    fun handleDetailed(
        owner: PhysicalOwner,
        identity: HidPhysicalIdentity,
        control: SemanticControl,
        action: PhysicalAction,
        timeMillis: Long,
    ): HidCaptureResult {
        val activeOwner = activePress?.owner
        val previousSecondary = pendingSecondaryPress?.takeIf {
            control == SemanticControl.SECONDARY && it.owner == owner && it.identity.sameControl(identity)
        }
        val releaseToNextDownMillis = if (action == PhysicalAction.DOWN) {
            previousSecondary?.let { timeMillis - it.timing.upAtMillis }
        } else {
            null
        }
        if (releaseToNextDownMillis != null && releaseToNextDownMillis !in 0..timing.doublePressMillis) {
            pendingSecondaryPress = null
        }
        if (action == PhysicalAction.DOWN && activePress == null) {
            activePress = ActivePress(owner, identity, timeMillis, releaseToNextDownMillis)
        }
        val events = classifier.handle(PhysicalInput(owner, control, action, timeMillis))
        if (events.any { it.action == SemanticAction.LONG }) longObserved = true
        if (action == PhysicalAction.CANCEL && owner == activePress?.owner) {
            clearActive()
            return HidCaptureResult(reason = "cancelled")
        }
        if (action == PhysicalAction.REPEAT) return HidCaptureResult(reason = "repeat-ignored")
        if (action == PhysicalAction.DOWN) {
            if (activeOwner != null) return HidCaptureResult(reason = "down-ignored:active-owner=$activeOwner")
            return HidCaptureResult(
                reason = when {
                    control != SemanticControl.SECONDARY -> "down-accepted"
                    releaseToNextDownMillis == null -> "secondary-down:first-tap"
                    releaseToNextDownMillis in 0..timing.doublePressMillis ->
                        "secondary-down:confirmation gap=${releaseToNextDownMillis}ms"
                    else -> "secondary-down:gap-exceeded ${releaseToNextDownMillis}ms; restarted-first-tap"
                },
            )
        }
        if (action != PhysicalAction.UP) return HidCaptureResult(reason = "action-ignored")
        val press = activePress?.takeIf { it.owner == owner && it.identity.sameControl(identity) }
            ?: return HidCaptureResult(reason = "up-owner-mismatch")
        val timing = HidPressTiming(press.downAtMillis, timeMillis)
        val duration = timing.upAtMillis - timing.downAtMillis
        val behavior = when {
            events.any { it.action == SemanticAction.DOUBLE } -> BehaviorClass.DOUBLE
            events.any { it.action == SemanticAction.SHORT } -> BehaviorClass.SHORT
            longObserved || events.any { it.action == SemanticAction.LONG } -> BehaviorClass.LONG
            control.isDirectional() && events.any { it.action == SemanticAction.END } -> BehaviorClass.DIRECTIONAL
            else -> {
                if (control == SemanticControl.SECONDARY) {
                    pendingSecondaryPress = PendingSecondaryPress(owner, press.identity, timing)
                }
                clearActive()
                return HidCaptureResult(
                    reason = if (control == SemanticControl.SECONDARY) {
                        "secondary-up:awaiting-second-tap duration=${duration}ms"
                    } else {
                        "up-unclassified duration=${duration}ms"
                    },
                )
            }
        }
        val presses = if (behavior == BehaviorClass.DOUBLE) {
            listOfNotNull(
                pendingSecondaryPress
                    ?.takeIf { it.owner == owner && it.identity.sameControl(press.identity) }
                    ?.timing,
                timing,
            )
        } else {
            listOf(timing)
        }
        if (behavior == BehaviorClass.DOUBLE || behavior == BehaviorClass.LONG) pendingSecondaryPress = null
        clearActive()
        return HidCaptureResult(
            operation = QualificationOperation(HidOperationSignature(press.identity, behavior), hidPresses = presses),
            reason = "accepted-$behavior duration=${duration}ms" +
                (press.releaseToNextDownMillis?.let { " gap=${it}ms" } ?: ""),
        )
    }

    fun advance(timeMillis: Long) {
        pendingSecondaryPress = pendingSecondaryPress?.takeIf {
            timeMillis - it.timing.upAtMillis <= timing.doublePressMillis
        }
        if (classifier.advance(timeMillis).any { it.action == SemanticAction.LONG }) {
            longObserved = true
            pendingSecondaryPress = null
        }
    }

    fun cancelAll(timeMillis: Long) {
        classifier.cancelAll(timeMillis)
        pendingSecondaryPress = null
        clearActive()
    }

    fun cancelSource(source: PhysicalSource, deviceId: Int, timeMillis: Long): Boolean {
        val activeCancelled = activePress?.owner?.let { it.source == source && it.deviceId == deviceId } == true
        val pendingCancelled = pendingSecondaryPress?.owner?.let {
            it.source == source && it.deviceId == deviceId
        } == true
        classifier.cancelSource(source, deviceId, timeMillis)
        pendingSecondaryPress = pendingSecondaryPress?.takeUnless {
            it.owner.source == source && it.owner.deviceId == deviceId
        }
        if (activeCancelled) clearActive()
        return activeCancelled || pendingCancelled
    }

    private fun clearActive() {
        activePress = null
        longObserved = false
    }

    private fun SemanticControl.isDirectional() =
        this == SemanticControl.LEFT || this == SemanticControl.RIGHT ||
            this == SemanticControl.UP || this == SemanticControl.DOWN
}
