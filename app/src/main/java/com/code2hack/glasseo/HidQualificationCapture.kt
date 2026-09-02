package com.code2hack.glasseo

class HidQualificationCapture(
    private val classifier: InputClassifier = InputClassifier(),
) {
    private var activeIdentity: HidPhysicalIdentity? = null
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
        if (action == PhysicalAction.DOWN) activeIdentity = identity
        val events = classifier.handle(PhysicalInput(owner, control, action, timeMillis))
        if (events.any { it.action == SemanticAction.LONG }) longObserved = true
        if (action != PhysicalAction.UP) return null

        val behavior = when {
            events.any { it.action == SemanticAction.DOUBLE } -> BehaviorClass.DOUBLE
            events.any { it.action == SemanticAction.SHORT } -> BehaviorClass.SHORT
            longObserved || events.any { it.action == SemanticAction.LONG } -> BehaviorClass.LONG
            control.isDirectional() && events.any { it.action == SemanticAction.END } -> BehaviorClass.DIRECTIONAL
            else -> return null
        }
        val capturedIdentity = activeIdentity ?: return null
        activeIdentity = null
        longObserved = false
        return QualificationOperation(HidOperationSignature(capturedIdentity, behavior))
    }

    fun advance(timeMillis: Long) {
        if (classifier.advance(timeMillis).any { it.action == SemanticAction.LONG }) longObserved = true
    }

    fun cancelAll(timeMillis: Long) {
        classifier.cancelAll(timeMillis)
        activeIdentity = null
        longObserved = false
    }

    fun cancelSource(source: PhysicalSource, deviceId: Int, timeMillis: Long) {
        classifier.cancelSource(source, deviceId, timeMillis)
        activeIdentity = null
        longObserved = false
    }

    private fun SemanticControl.isDirectional() =
        this == SemanticControl.LEFT || this == SemanticControl.RIGHT ||
            this == SemanticControl.UP || this == SemanticControl.DOWN
}
