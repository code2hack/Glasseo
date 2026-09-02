package com.code2hack.glasseo

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
        .put("complete", state.complete)
        .toString()
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
