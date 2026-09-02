package com.code2hack.glasseo

enum class HidQualificationStage { BINDING, RECOGNITION, COMPLETE }

enum class HidQualificationPhase { AWAITING_INPUT, STEP_CONFIRMED, COMPLETE }

data class HidQualificationSnapshot(
    val sessionId: String,
    val revision: Long,
    val stage: HidQualificationStage,
    val stepIndex: Int,
    val phase: HidQualificationPhase,
    val bindingControl: SemanticControl?,
    val recognitionStep: QualificationStep?,
    val prompt: String,
    val error: String? = null,
    val settleDeadlineMillis: Long? = null,
)

data class HidQualificationRenderAck(
    val sessionId: String,
    val revision: Long,
    val stage: HidQualificationStage,
    val stepIndex: Int,
    val phase: HidQualificationPhase,
)

data class HidFlowDecision(
    val reason: String,
    val snapshotChanged: Boolean = false,
    val operation: QualificationOperation? = null,
)

data class HidAcknowledgementResult(
    val accepted: Boolean,
    val snapshotChanged: Boolean,
    val armed: Boolean,
)

class HidQualificationFlow(
    private val sessionId: String,
    val expectedPeripheral: HidPeripheralIdentity,
    val bindings: HidBindingMap = HidBindingMap(),
    private val timing: InputTiming = InputTiming(),
) {
    private data class ActivePress(
        val owner: PhysicalOwner,
        val identity: HidPhysicalIdentity,
        val downAtMillis: Long,
    )

    private val bindingOrder = listOf(
        SemanticControl.PRIMARY,
        SemanticControl.SECONDARY,
        SemanticControl.COMMAND,
        SemanticControl.UP,
        SemanticControl.DOWN,
        SemanticControl.LEFT,
        SemanticControl.RIGHT,
    )
    private var activePress: ActivePress? = null
    private val recognitionCapture = HidQualificationCapture(timing)
    private var revision = 1L
    private var armed = false

    val operations = linkedMapOf<QualificationStep, OperationResult>()

    var snapshot = snapshot(HidQualificationStage.BINDING, 0, HidQualificationPhase.AWAITING_INPUT)
        private set

    val isArmed: Boolean
        get() = armed

    val hasPendingInput: Boolean
        get() = activePress != null || recognitionCapture.hasPendingInput

    fun acknowledge(ack: HidQualificationRenderAck): HidAcknowledgementResult {
        if (ack != snapshot.renderAck()) return HidAcknowledgementResult(false, false, armed)
        if (snapshot.phase == HidQualificationPhase.STEP_CONFIRMED) {
            mutate(snapshot.stage, snapshot.stepIndex, HidQualificationPhase.AWAITING_INPUT)
            return HidAcknowledgementResult(true, true, false)
        }
        if (snapshot.phase == HidQualificationPhase.AWAITING_INPUT) armed = true
        return HidAcknowledgementResult(true, false, armed)
    }

    fun handle(input: HidRawInput): HidFlowDecision {
        if (!armed && activePress == null && !recognitionCapture.hasActivePress) {
            return HidFlowDecision("Rejected: flow is not armed")
        }
        if (!input.identity.peripheral.sameDevice(expectedPeripheral)) {
            return HidFlowDecision("Rejected: use the selected HID device")
        }
        return when (snapshot.stage) {
            HidQualificationStage.BINDING -> when (input.action) {
                PhysicalAction.DOWN -> handleBindingDown(input)
                PhysicalAction.REPEAT -> handleBindingRepeat(input)
                PhysicalAction.UP -> handleBindingUp(input)
                PhysicalAction.CANCEL -> handleBindingCancel(input)
            }
            HidQualificationStage.RECOGNITION -> handleRecognition(input)
            HidQualificationStage.COMPLETE -> HidFlowDecision("Rejected: qualification is complete")
        }
    }

    fun suspendCapture() {
        armed = false
    }

    fun cancelCapture(reason: String) {
        activePress = null
        recognitionCapture.cancelAll(0)
        armed = false
        if (snapshot.stage != HidQualificationStage.COMPLETE) {
            mutate(snapshot.stage, snapshot.stepIndex, HidQualificationPhase.AWAITING_INPUT, "Input cancelled: $reason")
        }
    }

    fun result(): HidQualificationResult? = if (snapshot.stage == HidQualificationStage.COMPLETE) {
        HidQualificationResult(expectedPeripheral, bindings.snapshot(), operations.toMap())
    } else {
        null
    }

    private fun handleBindingDown(input: HidRawInput): HidFlowDecision {
        if (activePress != null) return HidFlowDecision("Rejected: another DOWN is active")
        activePress = ActivePress(input.owner(), input.identity, input.eventTimeMillis)
        return HidFlowDecision("DOWN received; waiting for matching UP")
    }

    private fun handleBindingRepeat(input: HidRawInput): HidFlowDecision {
        val press = activePress ?: return HidFlowDecision("Repeat ignored: no admitted DOWN")
        if (!press.matches(input)) {
            return HidFlowDecision("Rejected: repeat does not match admitted DOWN")
        }
        return HidFlowDecision("Repeat ignored; waiting for matching UP")
    }

    private fun handleBindingCancel(input: HidRawInput): HidFlowDecision {
        val press = activePress ?: return HidFlowDecision("Cancel ignored: no admitted DOWN")
        if (!press.matches(input)) {
            return HidFlowDecision("Rejected: CANCEL does not match admitted DOWN")
        }
        activePress = null
        return HidFlowDecision("Input cancelled")
    }

    private fun handleBindingUp(input: HidRawInput): HidFlowDecision {
        val press = activePress ?: return HidFlowDecision("Rejected: UP without DOWN")
        if (!press.matches(input)) {
            return HidFlowDecision("Rejected: UP does not match admitted DOWN")
        }
        activePress = null
        val duration = input.eventTimeMillis - press.downAtMillis
        if (duration !in 0 until timing.longPressMillis) {
            return HidFlowDecision("Complete DOWN/UP rejected: binding press must be short")
        }
        val control = checkNotNull(snapshot.bindingControl)
        if (!bindings.bind(control, press.identity)) {
            return HidFlowDecision("Complete DOWN/UP rejected: duplicate or mismatched HID identity")
        }
        armed = false
        val nextIndex = snapshot.stepIndex + 1
        if (nextIndex < bindingOrder.size) {
            mutate(HidQualificationStage.BINDING, nextIndex, HidQualificationPhase.STEP_CONFIRMED)
        } else {
            mutate(HidQualificationStage.RECOGNITION, 0, HidQualificationPhase.STEP_CONFIRMED)
        }
        return HidFlowDecision(
            "Complete DOWN/UP received and accepted: ${control.name} bound",
            snapshotChanged = true,
        )
    }

    private fun handleRecognition(input: HidRawInput): HidFlowDecision {
        val step = checkNotNull(snapshot.recognitionStep)
        val expected = step.control
        val received = bindings.controlFor(input.identity)
            ?: return HidFlowDecision("Rejected: unbound HID identity")
        if (received != expected) {
            return HidFlowDecision("Rejected: expected ${expected.name} but received ${received.name}")
        }
        val capture = recognitionCapture.handleDetailed(
            input.owner(),
            input.identity,
            received,
            input.action,
            input.eventTimeMillis,
        )
        val operation = capture.operation ?: return HidFlowDecision(
            if (step == QualificationStep.DOUBLE_SECONDARY &&
                capture.reason.startsWith("secondary-up:awaiting-second-tap")
            ) {
                "First complete SECONDARY cycle accepted; waiting for second cycle"
            } else {
                capture.reason
            },
        )
        val behavior = (operation.signature as HidOperationSignature).behavior
        if (behavior != step.behavior) {
            return HidFlowDecision("Complete DOWN/UP rejected: expected ${step.behavior}")
        }
        val presses = operation.hidPresses
        operations[step] = OperationResult(
            step,
            OperationVerdict.PASS,
            SuppressionOutcome.NOT_NEEDED,
            hidCaptures = listOf(presses),
        )
        armed = false
        val nextIndex = snapshot.stepIndex + 1
        if (nextIndex < QualificationStep.entries.size) {
            mutate(HidQualificationStage.RECOGNITION, nextIndex, HidQualificationPhase.STEP_CONFIRMED)
        } else {
            mutate(HidQualificationStage.COMPLETE, nextIndex, HidQualificationPhase.COMPLETE)
        }
        return HidFlowDecision(
            "Complete DOWN/UP received and accepted: ${step.name}",
            snapshotChanged = true,
            operation = operation,
        )
    }

    private fun mutate(
        stage: HidQualificationStage,
        stepIndex: Int,
        phase: HidQualificationPhase,
        error: String? = null,
    ) {
        armed = false
        revision++
        snapshot = snapshot(stage, stepIndex, phase, error)
    }

    private fun snapshot(
        stage: HidQualificationStage,
        stepIndex: Int,
        phase: HidQualificationPhase,
        error: String? = null,
    ): HidQualificationSnapshot {
        val control = bindingOrder.getOrNull(stepIndex).takeIf { stage == HidQualificationStage.BINDING }
        val recognition = QualificationStep.entries.getOrNull(stepIndex)
            .takeIf { stage == HidQualificationStage.RECOGNITION }
        return HidQualificationSnapshot(
            sessionId,
            revision,
            stage,
            stepIndex,
            phase,
            control,
            recognition,
            when (stage) {
                HidQualificationStage.BINDING -> "Press the button you wanna bind"
                HidQualificationStage.RECOGNITION -> "Perform ${recognition?.name}"
                HidQualificationStage.COMPLETE -> "HID qualification complete"
            },
            error,
        )
    }

    private fun HidQualificationSnapshot.renderAck() = HidQualificationRenderAck(
        sessionId,
        revision,
        stage,
        stepIndex,
        phase,
    )

    private fun HidRawInput.owner() = PhysicalOwner(PhysicalSource.HID, deviceId, identity.keyCode)

    private fun ActivePress.matches(input: HidRawInput) =
        owner == input.owner() && identity.sameControl(input.identity)
}
