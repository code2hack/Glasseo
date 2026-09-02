package com.code2hack.glasseo

import org.json.JSONObject

object NativeSemanticMessage {
    fun encode(event: SemanticInteraction): String = JSONObject()
        .put("type", "semantic-input")
        .put("control", event.control.name)
        .put("action", event.action.name)
        .put("interactionId", event.interactionId)
        .put("timeMillis", event.timeMillis)
        .toString()
}
