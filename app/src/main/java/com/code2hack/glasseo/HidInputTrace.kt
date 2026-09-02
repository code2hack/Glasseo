package com.code2hack.glasseo

data class HidRawInput(
    val action: PhysicalAction,
    val identity: HidPhysicalIdentity,
    val deviceId: Int,
    val repeatCount: Int,
    val eventTimeMillis: Long,
    val receivedElapsedRealtimeMillis: Long,
    val eventSource: Int = identity.sources,
) {
    val rawAction: String
        get() = when (action) {
            PhysicalAction.DOWN, PhysicalAction.REPEAT -> "DOWN"
            PhysicalAction.UP -> "UP"
            PhysicalAction.CANCEL -> "CANCEL"
        }
}

data class HidRawReceipt(
    val sequence: Long,
    val action: String,
    val identity: HidPhysicalIdentity,
    val deviceId: Int,
    val repeatCount: Int,
    val eventTimeMillis: Long,
    val receivedElapsedRealtimeMillis: Long,
    val eventSource: Int,
    val pressDurationMillis: Long?,
    val releaseToNextDownMillis: Long?,
)

data class HidInputDecision(val sequence: Long, val reason: String)

data class HidInputTraceEntry(
    val receipt: HidRawReceipt,
    val reason: String,
)

data class HidInputTraceSnapshot(
    val events: List<HidInputTraceEntry>,
    val totalRawReceipts: Int,
    val totalDecisions: Int,
    val droppedRecords: Int,
    val attempt: HidAttemptMarker?,
)

enum class HidAttemptStatus { AWAITING_ANDROID_EVENT, ANDROID_EVENT_RECEIVED, NO_ANDROID_EVENT }

data class HidAttemptMarker(
    val attemptId: String,
    val operation: QualificationStep,
    val phase: HidQualificationPhase,
    val expectedPeripheral: HidPeripheralIdentity,
    val expectedIdentity: HidPhysicalIdentity?,
    val supervisorElapsedRealtimeMillis: Long,
    val startedElapsedRealtimeMillis: Long,
    val watchdogDeadlineMillis: Long,
    val status: HidAttemptStatus,
    val firstRawSequence: Long? = null,
)

class HidInputTraceRecorder(private val limit: Int = 8) {
    private val receipts = mutableListOf<HidRawReceipt>()
    private val decisions = mutableListOf<HidInputDecision>()
    private val activeDowns = mutableMapOf<HidPhysicalIdentity, Long>()
    private val releases = mutableMapOf<HidPhysicalIdentity, Long>()
    private var sequence = 0L
    private var attempt: HidAttemptMarker? = null

    init {
        require(limit > 0)
    }

    fun recordRaw(input: HidRawInput): HidRawReceipt {
        val duration = when (input.action) {
            PhysicalAction.DOWN -> {
                activeDowns[input.identity] = input.eventTimeMillis
                null
            }
            PhysicalAction.REPEAT -> activeDowns[input.identity]?.let { input.eventTimeMillis - it }
            PhysicalAction.UP, PhysicalAction.CANCEL -> activeDowns.remove(input.identity)
                ?.let { input.eventTimeMillis - it }
        }
        val gap = if (input.action == PhysicalAction.DOWN) {
            releases[input.identity]?.let { input.eventTimeMillis - it }
        } else {
            null
        }
        if (input.action == PhysicalAction.UP || input.action == PhysicalAction.CANCEL) {
            releases[input.identity] = input.eventTimeMillis
        }
        val receipt = HidRawReceipt(
            ++sequence,
            input.rawAction,
            input.identity,
            input.deviceId,
            input.repeatCount,
            input.eventTimeMillis,
            input.receivedElapsedRealtimeMillis,
            input.eventSource,
            duration,
            gap,
        )
        receipts += receipt
        attempt = attempt?.let { marker ->
            if (marker.status == HidAttemptStatus.AWAITING_ANDROID_EVENT &&
                input.identity.peripheral.sameDevice(marker.expectedPeripheral) &&
                (marker.expectedIdentity == null || input.identity.sameControl(marker.expectedIdentity))
            ) {
                marker.copy(status = HidAttemptStatus.ANDROID_EVENT_RECEIVED, firstRawSequence = receipt.sequence)
            } else {
                marker
            }
        }
        return receipt
    }

    fun recordDecision(sequence: Long, reason: String): HidInputDecision {
        require(receipts.any { it.sequence == sequence }) { "Unknown HID raw receipt $sequence" }
        return HidInputDecision(sequence, reason).also(decisions::add)
    }

    fun record(input: HidRawInput, reason: String): HidInputTraceEntry {
        val receipt = recordRaw(input)
        recordDecision(receipt.sequence, reason)
        return HidInputTraceEntry(receipt, reason)
    }

    fun snapshot(): HidInputTraceSnapshot {
        val latestDecisions = decisions.associateBy(HidInputDecision::sequence)
        return HidInputTraceSnapshot(
            receipts.takeLast(limit).map { receipt ->
                HidInputTraceEntry(receipt, latestDecisions[receipt.sequence]?.reason ?: "Awaiting decision")
            },
            receipts.size,
            decisions.size,
            droppedRecords = 0,
            attempt,
        )
    }

    fun startAttempt(
        attemptId: String,
        operation: QualificationStep,
        phase: HidQualificationPhase,
        expectedPeripheral: HidPeripheralIdentity,
        expectedIdentity: HidPhysicalIdentity?,
        supervisorElapsedRealtimeMillis: Long,
        startedElapsedRealtimeMillis: Long,
        watchdogMillis: Long,
    ): HidAttemptMarker {
        require(attemptId.matches(Regex("[A-Za-z0-9_-]{1,32}"))) { "Invalid attempt ID" }
        require(supervisorElapsedRealtimeMillis >= 0) { "Invalid supervisor time" }
        require(watchdogMillis > 0)
        return HidAttemptMarker(
            attemptId,
            operation,
            phase,
            expectedPeripheral,
            expectedIdentity,
            supervisorElapsedRealtimeMillis,
            startedElapsedRealtimeMillis,
            startedElapsedRealtimeMillis + watchdogMillis,
            HidAttemptStatus.AWAITING_ANDROID_EVENT,
        ).also { attempt = it }
    }

    fun expireAttempt(attemptId: String, nowElapsedRealtimeMillis: Long): HidAttemptMarker? {
        val marker = attempt?.takeIf { it.attemptId == attemptId } ?: return null
        if (marker.status != HidAttemptStatus.AWAITING_ANDROID_EVENT || nowElapsedRealtimeMillis < marker.watchdogDeadlineMillis) {
            return marker
        }
        return marker.copy(status = HidAttemptStatus.NO_ANDROID_EVENT).also { attempt = it }
    }

    fun allRawReceipts(): List<HidRawReceipt> = receipts.toList()

    fun allDecisions(): List<HidInputDecision> = decisions.toList()

    fun clear() {
        receipts.clear()
        decisions.clear()
        activeDowns.clear()
        releases.clear()
        sequence = 0
        attempt = null
    }
}
