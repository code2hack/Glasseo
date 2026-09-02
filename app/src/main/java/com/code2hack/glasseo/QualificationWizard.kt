package com.code2hack.glasseo

enum class QualificationMode { BUILT_IN, HID }

data class HidOperationSignature(
    val identity: HidPhysicalIdentity,
    override val behavior: BehaviorClass,
) : StableOperationSignature

enum class OperationVerdict { PASS, UNAVAILABLE }

enum class SuppressionOutcome { NOT_NEEDED, SUCCEEDED, FAILED }

enum class BuiltInCapability { AVAILABLE_SAFE, AVAILABLE_WITH_SUPPRESSION, UNAVAILABLE_BUILTIN }

data class QualificationOperation(
    val signature: StableOperationSignature,
    val deterministicDelivery: Boolean = true,
    val semanticBehaviorCount: Int = 1,
    val unacceptableSideEffect: Boolean = false,
    val suppression: SuppressionOutcome = SuppressionOutcome.NOT_NEEDED,
) {
    val passes: Boolean
        get() = deterministicDelivery && semanticBehaviorCount == 1 && !unacceptableSideEffect &&
            suppression != SuppressionOutcome.FAILED
}

data class OperationResult(
    val step: QualificationStep,
    val verdict: OperationVerdict,
    val suppression: SuppressionOutcome,
    val deterministicDelivery: Boolean = true,
    val semanticBehaviorCount: Int = 1,
    val unacceptableSideEffect: Boolean = false,
)

val ACCEPTED_BUILT_IN_OPERATION_RESULTS: Map<QualificationStep, OperationResult> = listOf(
    QualificationStep.SHORT_COMMAND,
    QualificationStep.LONG_COMMAND,
).associateWith { step ->
    OperationResult(step, OperationVerdict.PASS, SuppressionOutcome.SUCCEEDED)
}

data class QualificationState(
    val step: QualificationStep,
    val prompt: String,
    val error: String? = null,
    val awaitingConfirmation: Boolean = false,
    val capturedIdentity: String? = null,
    val complete: Boolean = false,
)

class QualificationWizard(
    private val mode: QualificationMode,
    val bindings: HidBindingMap = HidBindingMap(),
    startIndex: Int = 0,
    initialResults: Map<QualificationStep, OperationResult> = emptyMap(),
) {
    private var index = startIndex.coerceIn(0, QualificationStep.entries.lastIndex)
    private var candidate: QualificationOperation? = null
    val results = initialResults.toMutableMap()

    val currentStep: QualificationStep
        get() = QualificationStep.entries[index]

    var state: QualificationState = stateFor()
        private set

    fun capture(operation: QualificationOperation) {
        if (state.complete) return
        val step = QualificationStep.entries[index]
        if (operation.signature.behavior != step.behavior) {
            reset("Two operations must be the same, try again")
            return
        }
        if (mode == QualificationMode.HID) {
            val signature = operation.signature as? HidOperationSignature ?: return reset("HID input required")
            val expected = bindings.identityFor(step.control)
            if (step.verifiesExistingBinding && signature.identity != expected) {
                reset("Use the same ${step.control.name} button")
                return
            }
            val duplicate = bindings.controlFor(signature.identity)
            if (!step.verifiesExistingBinding && duplicate != null && duplicate != step.control) {
                reset("Button is already bound to ${duplicate.name}")
                return
            }
        }
        val first = candidate
        if (first == null) {
            candidate = operation
            state = stateFor(awaitingConfirmation = true, identity = operation.signature.displayIdentity())
            return
        }
        if (first.signature != operation.signature) {
            reset("Two operations must be the same, try again")
            return
        }

        if (mode == QualificationMode.HID && !step.verifiesExistingBinding) {
            bindings.bind(step.control, (operation.signature as HidOperationSignature).identity)
        }
        results[step] = OperationResult(
            step,
            if (first.passes && operation.passes) OperationVerdict.PASS else OperationVerdict.UNAVAILABLE,
            listOf(first.suppression, operation.suppression).maxBy { it.ordinal },
            first.deterministicDelivery && operation.deterministicDelivery,
            maxOf(first.semanticBehaviorCount, operation.semanticBehaviorCount),
            first.unacceptableSideEffect || operation.unacceptableSideEffect,
        )
        candidate = null
        if (index == QualificationStep.entries.lastIndex) {
            state = stateFor(complete = true)
        } else {
            index++
            state = stateFor()
        }
    }

    fun checkpoint() = QualificationCheckpoint(mode, index, candidate != null, results.toMap())

    fun cancelAttempt() = reset("Input cancelled")

    private fun reset(error: String) {
        candidate = null
        state = stateFor(error = error)
    }

    private fun stateFor(
        error: String? = null,
        awaitingConfirmation: Boolean = false,
        identity: String? = null,
        complete: Boolean = false,
    ) = QualificationState(
        QualificationStep.entries[index],
        when {
            awaitingConfirmation && mode == QualificationMode.HID -> "Press the same button again"
            awaitingConfirmation -> "Perform the same intended action again"
            mode == QualificationMode.HID -> "Press the button you wanna bind"
            else -> "Perform the intended action"
        },
        error,
        awaitingConfirmation,
        identity,
        complete,
    )
}

data class QualificationCheckpoint(
    val mode: QualificationMode,
    val stepIndex: Int,
    val awaitingConfirmation: Boolean,
    val results: Map<QualificationStep, OperationResult> = emptyMap(),
) {
    val step: QualificationStep
        get() = QualificationStep.entries[stepIndex]

    fun encode(): String = listOf(
        mode.name,
        stepIndex,
        awaitingConfirmation,
        results.values.joinToString(",") {
            listOf(
                it.step.name,
                it.verdict.name,
                it.suppression.name,
                it.deterministicDelivery,
                it.semanticBehaviorCount,
                it.unacceptableSideEffect,
            ).joinToString(":")
        },
    ).joinToString("|")

    companion object {
        fun decode(value: String): QualificationCheckpoint {
            val parts = value.split('|')
            require(parts.size in 3..4)
            val index = parts[1].toInt()
            require(index in QualificationStep.entries.indices)
            val results = parts.getOrNull(3).orEmpty().takeIf(String::isNotEmpty)?.split(',')?.associate { encoded ->
                val result = encoded.split(':')
                require(result.size == 3 || result.size == 6)
                val step = QualificationStep.valueOf(result[0])
                step to OperationResult(
                    step,
                    OperationVerdict.valueOf(result[1]),
                    SuppressionOutcome.valueOf(result[2]),
                    result.getOrNull(3)?.toBooleanStrict() ?: true,
                    result.getOrNull(4)?.toInt() ?: 1,
                    result.getOrNull(5)?.toBooleanStrict() ?: false,
                )
            }.orEmpty()
            return QualificationCheckpoint(
                QualificationMode.valueOf(parts[0]),
                index,
                parts[2].toBooleanStrict(),
                results,
            )
        }
    }
}

fun deriveCapabilities(results: Map<QualificationStep, OperationResult>): Map<SemanticControl, BuiltInCapability> =
    SemanticControl.entries.associateWith { control ->
        val required = QualificationStep.entries.filter { it.control == control }.mapNotNull(results::get)
        when {
            required.size != QualificationStep.entries.count { it.control == control } ||
                required.any { it.verdict == OperationVerdict.UNAVAILABLE } -> BuiltInCapability.UNAVAILABLE_BUILTIN
            required.any { it.suppression == SuppressionOutcome.SUCCEEDED } -> BuiltInCapability.AVAILABLE_WITH_SUPPRESSION
            else -> BuiltInCapability.AVAILABLE_SAFE
        }
    }

val QualificationStep.control: SemanticControl
    get() = when (this) {
        QualificationStep.SHORT_PRIMARY, QualificationStep.LONG_PRIMARY -> SemanticControl.PRIMARY
        QualificationStep.LONG_SECONDARY, QualificationStep.DOUBLE_SECONDARY -> SemanticControl.SECONDARY
        QualificationStep.SHORT_COMMAND, QualificationStep.LONG_COMMAND -> SemanticControl.COMMAND
        QualificationStep.UP -> SemanticControl.UP
        QualificationStep.DOWN -> SemanticControl.DOWN
        QualificationStep.LEFT -> SemanticControl.LEFT
        QualificationStep.RIGHT -> SemanticControl.RIGHT
    }

val QualificationStep.behavior: BehaviorClass
    get() = when (this) {
        QualificationStep.SHORT_PRIMARY, QualificationStep.SHORT_COMMAND -> BehaviorClass.SHORT
        QualificationStep.LONG_PRIMARY, QualificationStep.LONG_SECONDARY, QualificationStep.LONG_COMMAND -> BehaviorClass.LONG
        QualificationStep.DOUBLE_SECONDARY -> BehaviorClass.DOUBLE
        QualificationStep.UP, QualificationStep.DOWN, QualificationStep.LEFT, QualificationStep.RIGHT -> BehaviorClass.DIRECTIONAL
    }

val QualificationStep.verifiesExistingBinding: Boolean
    get() = this == QualificationStep.LONG_PRIMARY || this == QualificationStep.DOUBLE_SECONDARY ||
        this == QualificationStep.LONG_COMMAND

internal fun StableOperationSignature.displayIdentity(): String = when (this) {
    is HidOperationSignature -> "${identity.descriptor}:${identity.vendorId}:${identity.productId}:${identity.keyCode}:${identity.scanCode}"
    is BuiltInOperationSignature -> "keys=${keys.joinToString()}; broadcasts=${broadcasts.joinToString()}"
}
