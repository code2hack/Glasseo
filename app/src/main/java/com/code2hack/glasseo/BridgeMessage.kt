package com.code2hack.glasseo

import org.json.JSONObject

sealed interface BridgeMessage {
    data object Hello : BridgeMessage

    data class ProbeResult(
        val passed: Boolean,
        val checks: Map<String, Boolean>,
        val details: Map<String, String>,
    ) : BridgeMessage

    companion object {
        fun parse(value: String): BridgeMessage {
            val json = JSONObject(value)
            return when (json.optString("type")) {
                "hello" -> {
                    require(json.length() == 1) { "Malformed hello" }
                    Hello
                }
                "probe-result" -> parseProbe(json)
                else -> error("Unknown bridge message")
            }
        }

        private fun parseProbe(json: JSONObject): ProbeResult {
            require(json.length() == 4 && json.has("passed") && json.has("checks") && json.has("details")) {
                "Malformed probe result"
            }
            val checksJson = json.getJSONObject("checks")
            val detailsJson = json.getJSONObject("details")
            val checks = checksJson.keys().asSequence().associateWith { checksJson.getBoolean(it) }
            val details = detailsJson.keys().asSequence().associateWith { detailsJson.getString(it) }
            return ProbeResult(json.getBoolean("passed"), checks, details)
        }
    }
}
