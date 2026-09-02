package com.code2hack.glasseo

data class HidPressTiming(val downAtMillis: Long, val upAtMillis: Long)

class HidQualificationCapture(
    private val classifier: InputClassifier = InputClassifier(),
) {
    private data class ActivePress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val downAtMillis: Long,
    )

    private data class PendingSecondaryPress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val timing: HidPressTiming,
    )

    private var activePress: ActivePress? = null
    private var pendingSecondaryPress: PendingSecondaryPress? = null
    private var longObserved = false

    val nextDeadlineMillis: Long?
        get() = classifier.nextDeadlineMillis

    fun handle(
        owner: PhysicalOwner,
        identity: HidPhysicalIdentity,
        control: SemanticControl,
        action: PhysicalAction,
        timeMillis: Long,
    ): QualificationOperation? {
        if (action == PhysicalAction.DOWN && activePress == null) {
            activePress = ActivePress(owner, identity, timeMillis)
        }
        val events = classifier.handle(PhysicalInput(owner, control, action, timeMillis))
        if (events.any { it.action == SemanticAction.LONG }) longObserved = true
        if (action == PhysicalAction.CANCEL && owner == activePress?.owner) clearActive()
        if (action != PhysicalAction.UP) return null
        val press = activePress?.takeIf { it.owner == owner } ?: return null
        val timing = HidPressTiming(press.downAtMillis, timeMillis)

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
                return null
            }
        }
        val presses = if (behavior == BehaviorClass.DOUBLE) {
            listOfNotNull(
                pendingSecondaryPress
                    ?.takeIf { it.owner == owner && it.identity == press.identity }
                    ?.timing,
                timing,
            )
        } else {
            listOf(timing)
        }
        if (behavior == BehaviorClass.DOUBLE || behavior == BehaviorClass.LONG) pendingSecondaryPress = null
        clearActive()
        return QualificationOperation(HidOperationSignature(press.identity, behavior), hidPresses = presses)
    }

    fun advance(timeMillis: Long) {
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
