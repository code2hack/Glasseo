package com.code2hack.glasseo

enum class QualificationPhase {
    AWAITING_FIRST,
    SETTLING_FIRST,
    AWAITING_CONFIRMATION,
    SETTLING_SECOND,
    STEP_CONFIRMED,
}

data class QualificationPauseTarget(
    val step: QualificationStep,
    val phase: QualificationPhase = QualificationPhase.AWAITING_FIRST,
)

data class QualificationSnapshot(
    val sessionId: String,
    val mode: QualificationMode,
    val revision: Long,
    val step: QualificationStep,
    val phase: QualificationPhase,
    val attempt: Int,
    val operationId: Long?,
    val candidateDisplay: String?,
    val suppressionResult: SuppressionOutcome?,
    val settleDeadlineMillis: Long?,
    val prompt: String,
    val error: String?,
    val paused: Boolean,
    val complete: Boolean,
)

data class QualificationRenderAck(
    val sessionId: String,
    val revision: Long,
    val stepIndex: Int,
    val phase: QualificationPhase,
)

data class QualificationFinalizerToken(
    val sessionId: String,
    val stepEpoch: Long,
    val operationId: Long,
)

sealed interface CaptureAdmission {
    data class Accepted(val token: QualificationFinalizerToken) : CaptureAdmission
    data class Ignored(val reason: String) : CaptureAdmission
}

data class AcknowledgementResult(
    val accepted: Boolean,
    val snapshotChanged: Boolean,
    val armed: Boolean,
)

class QualificationSession(
    val mode: QualificationMode,
    val sessionId: String,
    bindings: HidBindingMap = HidBindingMap(),
    startIndex: Int = 0,
    initialResults: Map<QualificationStep, OperationResult> = emptyMap(),
    private val nowMillis: () -> Long,
    private val pauseAt: QualificationPauseTarget? = null,
) {
    val wizard = QualificationWizard(mode, bindings, startIndex, initialResults)
    private var revision = 1L
    private var stepEpoch = 1L
    private var nextOperationId = 1L
    private var pendingOperation: QualificationOperation? = null
    private var pendingToken: QualificationFinalizerToken? = null
    private var paused = false
    private var pauseBoundaryReached = false

    var armed = false
        private set

    var snapshot = snapshot(QualificationPhase.AWAITING_FIRST, 0, null, null, null, null)
        private set

    val hasPendingOperation: Boolean
        get() = pendingToken != null

    fun capture(operation: QualificationOperation): CaptureAdmission {
        if (!armed) return CaptureAdmission.Ignored(ignoreReason())
        val phase = snapshot.phase
        if (phase != QualificationPhase.AWAITING_FIRST && phase != QualificationPhase.AWAITING_CONFIRMATION) {
            return CaptureAdmission.Ignored(ignoreReason())
        }
        armed = false
        val operationId = nextOperationId++
        val token = QualificationFinalizerToken(sessionId, stepEpoch, operationId)
        pendingOperation = operation
        pendingToken = token
        val settling = if (phase == QualificationPhase.AWAITING_FIRST) {
            QualificationPhase.SETTLING_FIRST
        } else {
            QualificationPhase.SETTLING_SECOND
        }
        mutate(
            settling,
            if (settling == QualificationPhase.SETTLING_FIRST) 1 else 2,
            operationId,
            operation.signature.displayIdentity(),
            operation.suppression,
            nowMillis() + SETTLE_MILLIS,
        )
        return CaptureAdmission.Accepted(token)
    }

    fun finalize(token: QualificationFinalizerToken, completedOperation: QualificationOperation? = null): Boolean {
        val operation = completedOperation ?: pendingOperation ?: return false
        if (token != pendingToken || token.sessionId != sessionId || token.stepEpoch != stepEpoch) return false
        if (nowMillis() < checkNotNull(snapshot.settleDeadlineMillis)) return false
        val previousStep = wizard.currentStep
        pendingOperation = null
        pendingToken = null
        wizard.capture(operation)
        val nextPhase = when {
            wizard.state.complete || wizard.currentStep != previousStep -> QualificationPhase.STEP_CONFIRMED
            wizard.state.awaitingConfirmation -> QualificationPhase.AWAITING_CONFIRMATION
            else -> QualificationPhase.AWAITING_FIRST
        }
        if (wizard.currentStep != previousStep) stepEpoch++
        val prompt = when (nextPhase) {
            QualificationPhase.STEP_CONFIRMED ->
                "${previousStep.displayName} confirmed — next: ${wizard.currentStep.displayName}"
            else -> null
        }
        mutate(
            nextPhase,
            when (nextPhase) {
                QualificationPhase.AWAITING_FIRST -> 0
                QualificationPhase.AWAITING_CONFIRMATION -> 1
                else -> snapshot.attempt
            },
            token.operationId,
            wizard.state.capturedIdentity,
            operation.suppression,
            null,
            prompt,
        )
        return true
    }

    fun acknowledge(ack: QualificationRenderAck): AcknowledgementResult {
        if (ack.sessionId != snapshot.sessionId || ack.revision != snapshot.revision ||
            ack.stepIndex != snapshot.step.ordinal || ack.phase != snapshot.phase
        ) {
            return AcknowledgementResult(false, false, armed)
        }
        if (!pauseBoundaryReached && pauseAt?.let { target ->
                snapshot.step == target.step && snapshot.phase == target.phase
            } == true
        ) {
            pauseBoundaryReached = true
            paused = true
            armed = false
            mutate(
                snapshot.phase,
                snapshot.attempt,
                snapshot.operationId,
                snapshot.candidateDisplay,
                snapshot.suppressionResult,
                snapshot.settleDeadlineMillis,
                error = snapshot.error,
            )
            return AcknowledgementResult(true, true, false)
        }
        if (paused) return AcknowledgementResult(true, false, false)
        if (snapshot.phase == QualificationPhase.STEP_CONFIRMED && !snapshot.complete) {
            mutate(QualificationPhase.AWAITING_FIRST, 0, null, null, null, null)
            return AcknowledgementResult(true, true, false)
        }
        if (snapshot.phase == QualificationPhase.AWAITING_FIRST ||
            snapshot.phase == QualificationPhase.AWAITING_CONFIRMATION
        ) {
            armed = true
        }
        return AcknowledgementResult(true, false, armed)
    }

    fun cancelAttempt(error: String = "Input cancelled") {
        armed = false
        stepEpoch++
        pendingOperation = null
        pendingToken = null
        wizard.cancelAttempt()
        mutate(QualificationPhase.AWAITING_FIRST, 0, null, null, null, null, error)
    }

    fun suspendCapture() {
        armed = false
    }

    fun resume(): Boolean {
        if (!paused) return false
        paused = false
        armed = false
        mutate(
            snapshot.phase,
            snapshot.attempt,
            snapshot.operationId,
            snapshot.candidateDisplay,
            snapshot.suppressionResult,
            snapshot.settleDeadlineMillis,
            error = snapshot.error,
        )
        return true
    }

    private fun mutate(
        phase: QualificationPhase,
        attempt: Int,
        operationId: Long?,
        candidateDisplay: String?,
        suppressionResult: SuppressionOutcome?,
        settleDeadlineMillis: Long?,
        prompt: String? = null,
        error: String? = wizard.state.error,
    ) {
        revision++
        snapshot = snapshot(
            phase,
            attempt,
            operationId,
            candidateDisplay,
            suppressionResult,
            settleDeadlineMillis,
            prompt,
            error,
        )
    }

    private fun snapshot(
        phase: QualificationPhase,
        attempt: Int,
        operationId: Long?,
        candidateDisplay: String?,
        suppressionResult: SuppressionOutcome?,
        settleDeadlineMillis: Long?,
        prompt: String? = null,
        error: String? = wizard.state.error,
    ) = QualificationSnapshot(
        sessionId,
        mode,
        revision,
        wizard.currentStep,
        phase,
        attempt,
        operationId,
        candidateDisplay,
        suppressionResult,
        settleDeadlineMillis,
        prompt ?: when {
            paused -> PAUSED_PROMPT
            phase == QualificationPhase.SETTLING_FIRST -> "Captured — checking…"
            phase == QualificationPhase.SETTLING_SECOND -> "Captured — confirming…"
            else -> wizard.state.prompt
        },
        error,
        paused,
        wizard.state.complete,
    )

    private fun ignoreReason() = when {
        paused -> "paused"
        snapshot.phase == QualificationPhase.SETTLING_FIRST ||
            snapshot.phase == QualificationPhase.SETTLING_SECOND -> "settling"
        snapshot.phase == QualificationPhase.STEP_CONFIRMED -> "transition"
        else -> "snapshot-unacknowledged"
    }

    companion object {
        const val SETTLE_MILLIS = 1_200L
        const val PAUSED_PROMPT = "Qualification paused — resume with ADB"
    }
}
