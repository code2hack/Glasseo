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

data class HidInputTraceEntry(
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
    val reason: String,
)

class HidInputTraceRecorder(private val limit: Int = 8) {
    private val events = ArrayDeque<HidInputTraceEntry>()
    private val activeDowns = mutableMapOf<HidPhysicalIdentity, Long>()
    private val releases = mutableMapOf<HidPhysicalIdentity, Long>()
    private var sequence = 0L

    init {
        require(limit > 0)
    }

    fun record(input: HidRawInput, reason: String): HidInputTraceEntry {
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
        val event = HidInputTraceEntry(
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
            reason,
        )
        events += event
        if (events.size > limit) events.removeFirst()
        return event
    }

    fun snapshot(): List<HidInputTraceEntry> = events.toList()

    fun clear() {
        events.clear()
        activeDowns.clear()
        releases.clear()
        sequence = 0
    }
}
