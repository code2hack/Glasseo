package com.code2hack.glasseo

enum class SemanticControl { PRIMARY, SECONDARY, COMMAND, LEFT, RIGHT, UP, DOWN }

enum class PhysicalSource { BUILT_IN, HID }

enum class PhysicalAction { DOWN, REPEAT, UP, CANCEL }

enum class SemanticAction { BEGIN, UPDATE, END, CANCEL, SHORT, LONG, DOUBLE }

data class PhysicalOwner(
    val source: PhysicalSource,
    val deviceId: Int,
    val code: Int,
)

data class PhysicalInput(
    val owner: PhysicalOwner,
    val control: SemanticControl,
    val action: PhysicalAction,
    val timeMillis: Long,
)

data class SemanticInteraction(
    val control: SemanticControl,
    val action: SemanticAction,
    val interactionId: Long,
    val timeMillis: Long,
)

data class InputTiming(
    val longPressMillis: Long = 600,
    val doublePressMillis: Long = 350,
)

class InputClassifier(private val timing: InputTiming = InputTiming()) {
    private data class Active(
        val owner: PhysicalOwner,
        val control: SemanticControl,
        val id: Long,
        val downAt: Long,
        val doubleCandidate: Boolean,
        var longSent: Boolean = false,
    )

    private data class PendingSecondary(val owner: PhysicalOwner, val upAt: Long)

    private var active: Active? = null
    private var pendingSecondary: PendingSecondary? = null
    private var nextId = 1L

    val nextDeadlineMillis: Long?
        get() = active
            ?.takeIf { !it.control.isDirectional() && !it.longSent }
            ?.let { it.downAt + timing.longPressMillis }

    fun handle(input: PhysicalInput): List<SemanticInteraction> {
        expirePending(input.timeMillis)
        return when (input.action) {
            PhysicalAction.DOWN -> down(input)
            PhysicalAction.REPEAT -> repeat(input)
            PhysicalAction.UP -> up(input)
            PhysicalAction.CANCEL -> cancel(input.owner, input.timeMillis)
        }
    }

    fun advance(timeMillis: Long): List<SemanticInteraction> {
        expirePending(timeMillis)
        val current = active ?: return emptyList()
        if (current.control.isDirectional() || current.longSent || timeMillis < current.downAt + timing.longPressMillis) {
            return emptyList()
        }
        current.longSent = true
        pendingSecondary = null
        return listOf(current.event(SemanticAction.LONG, timeMillis))
    }

    fun cancelSource(source: PhysicalSource, deviceId: Int, timeMillis: Long): List<SemanticInteraction> {
        pendingSecondary = pendingSecondary?.takeUnless {
            it.owner.source == source && it.owner.deviceId == deviceId
        }
        val current = active ?: return emptyList()
        if (current.owner.source != source || current.owner.deviceId != deviceId) return emptyList()
        active = null
        return listOf(current.event(SemanticAction.CANCEL, timeMillis))
    }

    fun cancelAll(timeMillis: Long): List<SemanticInteraction> {
        pendingSecondary = null
        val current = active ?: return emptyList()
        active = null
        return listOf(current.event(SemanticAction.CANCEL, timeMillis))
    }

    private fun down(input: PhysicalInput): List<SemanticInteraction> {
        val current = active
        if (current != null) {
            return if (current.owner == input.owner) repeat(input) else emptyList()
        }
        val id = nextId++
        active = Active(
            input.owner,
            input.control,
            id,
            input.timeMillis,
            input.control == SemanticControl.SECONDARY &&
                pendingSecondary?.owner == input.owner &&
                input.timeMillis - pendingSecondary!!.upAt <= timing.doublePressMillis,
        )
        return if (input.control == SemanticControl.SECONDARY) {
            emptyList()
        } else {
            listOf(SemanticInteraction(input.control, SemanticAction.BEGIN, id, input.timeMillis))
        }
    }

    private fun repeat(input: PhysicalInput): List<SemanticInteraction> {
        val current = active ?: return emptyList()
        if (current.owner != input.owner || !current.control.isDirectional()) return emptyList()
        return listOf(current.event(SemanticAction.UPDATE, input.timeMillis))
    }

    private fun up(input: PhysicalInput): List<SemanticInteraction> {
        val current = active ?: return emptyList()
        if (current.owner != input.owner) return emptyList()
        active = null
        if (current.control.isDirectional()) return listOf(current.event(SemanticAction.END, input.timeMillis))
        if (current.longSent) return listOf(current.event(SemanticAction.END, input.timeMillis))
        if (input.timeMillis - current.downAt >= timing.longPressMillis) {
            pendingSecondary = null
            return listOf(
                current.event(SemanticAction.LONG, input.timeMillis),
                current.event(SemanticAction.END, input.timeMillis),
            )
        }
        if (current.control == SemanticControl.SECONDARY) {
            val action = if (current.doubleCandidate) SemanticAction.DOUBLE else null
            pendingSecondary = if (action == null) PendingSecondary(current.owner, input.timeMillis) else null
            return listOfNotNull(action?.let { current.event(it, input.timeMillis) })
        }
        return listOf(
            current.event(SemanticAction.SHORT, input.timeMillis),
            current.event(SemanticAction.END, input.timeMillis),
        )
    }

    private fun cancel(owner: PhysicalOwner, timeMillis: Long): List<SemanticInteraction> {
        pendingSecondary = pendingSecondary?.takeUnless { it.owner == owner }
        val current = active ?: return emptyList()
        if (current.owner != owner) return emptyList()
        active = null
        return listOf(current.event(SemanticAction.CANCEL, timeMillis))
    }

    private fun expirePending(timeMillis: Long) {
        pendingSecondary = pendingSecondary?.takeIf { timeMillis - it.upAt <= timing.doublePressMillis }
    }

    private fun Active.event(action: SemanticAction, timeMillis: Long) =
        SemanticInteraction(control, action, id, timeMillis)

    private fun SemanticControl.isDirectional() =
        this == SemanticControl.LEFT || this == SemanticControl.RIGHT ||
            this == SemanticControl.UP || this == SemanticControl.DOWN
}

class HudInputController(
    private val classifier: InputClassifier = InputClassifier(),
    private val onVisibilityChanged: (Boolean) -> Unit = {},
) {
    var isHidden: Boolean = false
        private set

    private var wakeOwner: PhysicalOwner? = null

    val nextDeadlineMillis: Long?
        get() = classifier.nextDeadlineMillis

    fun handle(input: PhysicalInput): List<SemanticInteraction> {
        wakeOwner?.let { owner ->
            if (owner == input.owner && (input.action == PhysicalAction.UP || input.action == PhysicalAction.CANCEL)) {
                wakeOwner = null
            }
            return emptyList()
        }
        if (isHidden && input.action == PhysicalAction.DOWN) {
            isHidden = false
            wakeOwner = input.owner
            onVisibilityChanged(true)
            return emptyList()
        }
        return applyHud(classifier.handle(input))
    }

    fun advance(timeMillis: Long): List<SemanticInteraction> = applyHud(classifier.advance(timeMillis))

    fun cancelSource(source: PhysicalSource, deviceId: Int, timeMillis: Long): List<SemanticInteraction> {
        wakeOwner = wakeOwner?.takeUnless { it.source == source && it.deviceId == deviceId }
        return classifier.cancelSource(source, deviceId, timeMillis)
    }

    fun cancelAll(timeMillis: Long): List<SemanticInteraction> {
        wakeOwner = null
        return classifier.cancelAll(timeMillis)
    }

    private fun applyHud(events: List<SemanticInteraction>): List<SemanticInteraction> {
        if (events.any { it.control == SemanticControl.SECONDARY && it.action == SemanticAction.DOUBLE }) {
            isHidden = true
            onVisibilityChanged(false)
        }
        return events.filterNot { it.control == SemanticControl.SECONDARY && it.action == SemanticAction.DOUBLE }
    }
}
