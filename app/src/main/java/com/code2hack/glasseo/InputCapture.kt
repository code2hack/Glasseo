package com.code2hack.glasseo

enum class QualificationStep {
    SHORT_PRIMARY,
    LONG_PRIMARY,
    LONG_SECONDARY,
    DOUBLE_SECONDARY,
    SHORT_COMMAND,
    LONG_COMMAND,
    UP,
    DOWN,
    LEFT,
    RIGHT,
}

enum class BehaviorClass { SHORT, LONG, DOUBLE, DIRECTIONAL }

sealed interface StableOperationSignature {
    val behavior: BehaviorClass
}

enum class CapturedKeyPhase { DOWN, UP, REPEAT }

data class CapturedKey(val keyCode: Int, val scanCode: Int, val phase: CapturedKeyPhase)

enum class MotionDirection { NONE, NEGATIVE, POSITIVE }

data class CapturedMotionPhase(val action: Int, val pointerCount: Int)

data class CapturedMotion(
    val channel: String,
    val phases: List<CapturedMotionPhase>,
    val maxPointerCount: Int,
    val source: Int,
    val horizontal: MotionDirection,
    val vertical: MotionDirection,
)

data class CapturedBroadcast(val action: String, val flags: Int, val ordered: Boolean)

data class BuiltInOperationSignature(
    override val behavior: BehaviorClass,
    val keys: List<CapturedKey>,
    val motions: List<CapturedMotion>,
    val broadcasts: List<CapturedBroadcast>,
    val focusLost: Boolean,
    val lifecycleEffects: Set<String>,
    val systemSideEffects: Set<String>,
) : StableOperationSignature

class InputCapture(
    private val behavior: BehaviorClass,
    private val movementThreshold: Float = 8f,
) {
    private data class MotionAccumulator(
        val channel: String,
        val source: Int,
        val phases: MutableList<CapturedMotionPhase> = mutableListOf(),
        var maxPointerCount: Int = 0,
        var startX: Float = 0f,
        var startY: Float = 0f,
        var endX: Float = 0f,
        var endY: Float = 0f,
    )

    private val keys = mutableListOf<CapturedKey>()
    private val motions = linkedMapOf<Pair<String, Int>, MotionAccumulator>()
    private val broadcasts = mutableListOf<CapturedBroadcast>()

    fun recordKey(keyCode: Int, scanCode: Int, phase: CapturedKeyPhase, @Suppress("UNUSED_PARAMETER") timeMillis: Long) {
        val key = CapturedKey(keyCode, scanCode, phase)
        if (phase != CapturedKeyPhase.REPEAT || keys.lastOrNull() != key) keys += key
    }

    fun recordMotion(
        channel: String,
        action: Int,
        pointerCount: Int,
        source: Int,
        x: Float,
        y: Float,
        @Suppress("UNUSED_PARAMETER") timeMillis: Long,
    ) {
        val motion = motions.getOrPut(channel to source) {
            MotionAccumulator(channel, source, startX = x, startY = y, endX = x, endY = y)
        }
        val phase = CapturedMotionPhase(action, pointerCount)
        if (motion.phases.lastOrNull() != phase) motion.phases += phase
        motion.maxPointerCount = maxOf(motion.maxPointerCount, pointerCount)
        motion.endX = x
        motion.endY = y
    }

    fun recordBroadcast(
        action: String,
        flags: Int,
        ordered: Boolean,
        @Suppress("UNUSED_PARAMETER") timeMillis: Long,
    ) {
        broadcasts += CapturedBroadcast(action, flags, ordered)
    }

    fun finish(
        focusLost: Boolean,
        lifecycleEffects: Set<String>,
        systemSideEffects: Set<String>,
    ) = BuiltInOperationSignature(
        behavior,
        keys.toList(),
        motions.values.map { motion ->
            CapturedMotion(
                motion.channel,
                motion.phases.toList(),
                motion.maxPointerCount,
                motion.source,
                direction(motion.endX - motion.startX),
                direction(motion.endY - motion.startY),
            )
        },
        broadcasts.toList(),
        focusLost,
        lifecycleEffects,
        systemSideEffects,
    )

    private fun direction(delta: Float) = when {
        delta < -movementThreshold -> MotionDirection.NEGATIVE
        delta > movementThreshold -> MotionDirection.POSITIVE
        else -> MotionDirection.NONE
    }
}

class BuiltInOperationRecognizer {
    private val signatures = mutableMapOf<BuiltInOperationSignature, QualificationStep>()

    fun qualify(step: QualificationStep, signature: BuiltInOperationSignature) {
        val existing = signatures[signature]
        require(existing == null || existing == step) { "Operation is already assigned to $existing" }
        signatures[signature] = step
    }

    fun recognize(signature: BuiltInOperationSignature): QualificationStep? = signatures[signature]
}
