package com.code2hack.glasseo

import org.json.JSONArray
import org.json.JSONObject

object NativeQualificationMessage {
    fun landing(): String = JSONObject().put("type", "qualification-landing").toString()

    fun state(state: QualificationSnapshot): String = JSONObject()
        .put("type", "qualification-state")
        .put("sessionId", state.sessionId)
        .put("mode", state.mode.name)
        .put("revision", state.revision)
        .put("stepIndex", state.step.ordinal)
        .put("stepName", state.step.displayName)
        .put("phase", state.phase.name)
        .put("attempt", state.attempt)
        .put("operationId", state.operationId ?: JSONObject.NULL)
        .put("candidateDisplay", state.candidateDisplay ?: JSONObject.NULL)
        .put("suppressionResult", state.suppressionResult?.name ?: JSONObject.NULL)
        .put("settleDeadlineMillis", state.settleDeadlineMillis ?: JSONObject.NULL)
        .put("description", state.step.description)
        .put("prompt", state.prompt)
        .put("error", state.error ?: JSONObject.NULL)
        .put("paused", state.paused)
        .put("complete", state.complete)
        .toString()

    fun hidState(state: HidQualificationSnapshot): String = JSONObject()
        .put("type", "hid-qualification-state")
        .put("sessionId", state.sessionId)
        .put("revision", state.revision)
        .put("stage", state.stage.name)
        .put("stepIndex", state.stepIndex)
        .put("stepCount", if (state.stage == HidQualificationStage.BINDING) 7 else 10)
        .put(
            "stepName",
            state.bindingControl?.let { "Bind ${it.name}" }
                ?: state.recognitionStep?.displayName
                ?: "Complete",
        )
        .put("phase", state.phase.name)
        .put("prompt", state.prompt)
        .put("error", state.error ?: JSONObject.NULL)
        .put("settleDeadlineMillis", JSONObject.NULL)
        .put("complete", state.stage == HidQualificationStage.COMPLETE)
        .toString()

    fun hidInputTrace(trace: HidInputTraceSnapshot): String = JSONObject()
        .put("type", "hid-input-trace")
        .put("events", JSONArray(trace.events.map(::hidInputTraceEvent)))
        .put("totalRawReceipts", trace.totalRawReceipts)
        .put("totalDecisions", trace.totalDecisions)
        .put("droppedRecords", trace.droppedRecords)
        .put("attempt", trace.attempt?.let(::hidAttemptMarker) ?: JSONObject.NULL)
        .toString()

    private fun hidAttemptMarker(marker: HidAttemptMarker) = JSONObject()
        .put("attemptId", marker.attemptId)
        .put("operation", marker.operation.name)
        .put("phase", marker.phase.name)
        .put("supervisorElapsedRealtimeMillis", marker.supervisorElapsedRealtimeMillis)
        .put("startedElapsedRealtimeMillis", marker.startedElapsedRealtimeMillis)
        .put("watchdogDeadlineMillis", marker.watchdogDeadlineMillis)
        .put("status", marker.status.name)
        .put("firstRawSequence", marker.firstRawSequence ?: JSONObject.NULL)

    private fun hidInputTraceEvent(event: HidInputTraceEntry): JSONObject = with(event.receipt) {
        JSONObject()
            .put("sequence", sequence)
            .put("action", action)
            .put("keyCode", identity.keyCode)
            .put("scanCode", identity.scanCode)
            .put("repeatCount", repeatCount)
            .put("eventTimeMillis", eventTimeMillis)
            .put("receivedElapsedRealtimeMillis", receivedElapsedRealtimeMillis)
            .put("eventSource", eventSource)
            .put("deviceId", deviceId)
            .put("descriptor", identity.descriptor)
            .put("vendorId", identity.vendorId)
            .put("productId", identity.productId)
            .put("sources", identity.sources)
            .put("physicalSource", PhysicalSource.HID.name)
            .put("pressDurationMillis", pressDurationMillis ?: JSONObject.NULL)
            .put("releaseToNextDownMillis", releaseToNextDownMillis ?: JSONObject.NULL)
            .put("reason", event.reason)
    }
}

val QualificationStep.displayName: String
    get() = name.split('_').joinToString(" ") { word ->
        if (word == "PRIMARY" || word == "SECONDARY" || word == "COMMAND" ||
            word == "UP" || word == "DOWN" || word == "LEFT" || word == "RIGHT"
        ) word
        else word.lowercase().replaceFirstChar(Char::uppercase)
    }

val QualificationStep.description: String
    get() = when (this) {
        QualificationStep.SHORT_PRIMARY -> "Briefly use the intended PRIMARY control"
        QualificationStep.LONG_PRIMARY -> "Hold the intended PRIMARY control"
        QualificationStep.LONG_SECONDARY -> "Hold the intended SECONDARY control"
        QualificationStep.DOUBLE_SECONDARY -> "Use the intended SECONDARY control twice"
        QualificationStep.SHORT_COMMAND -> "Briefly use the intended COMMAND control"
        QualificationStep.LONG_COMMAND -> "Hold the intended COMMAND control"
        QualificationStep.UP -> "Perform the intended UP operation"
        QualificationStep.DOWN -> "Perform the intended DOWN operation"
        QualificationStep.LEFT -> "Perform the intended LEFT operation"
        QualificationStep.RIGHT -> "Perform the intended RIGHT operation"
    }
