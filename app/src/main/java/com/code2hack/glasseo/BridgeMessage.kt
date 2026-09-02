package com.code2hack.glasseo

import org.json.JSONObject

sealed interface BridgeMessage {
    data object Hello : BridgeMessage

    data class SemanticReceived(
        val control: SemanticControl,
        val action: SemanticAction,
        val interactionId: Long,
    ) : BridgeMessage

    data class QualificationStart(val mode: QualificationMode) : BridgeMessage

    data class QualificationRendered(
        val sessionId: String,
        val revision: Long,
        val stepIndex: Int,
        val phase: QualificationPhase,
    ) : BridgeMessage

    data class ProbeResult(
        val passed: Boolean,
        val checks: Map<String, Boolean>,
        val details: Map<String, String>,
    ) : BridgeMessage {
        fun isPassing(): Boolean =
            passed && checks.keys == REQUIRED_CHECKS && details.keys == REQUIRED_CHECKS && checks.values.all { it }
    }

    companion object {
        val REQUIRED_CHECKS: Set<String> = linkedSetOf(
            "localHttpsOrigin",
            "textCodec",
            "promiseScheduling",
            "structuredStorageReopen",
            "secureRandom",
            "paseoRelayCrypto",
            "binaryWss",
            "untrustedBridgeRejected",
            "remoteNavigationRejected",
        )

        fun parse(value: String): BridgeMessage {
            val json = JSONObject(value)
            return when (json.optString("type")) {
                "hello" -> {
                    require(json.length() == 1) { "Malformed hello" }
                    Hello
                }
                "probe-result" -> parseProbe(json)
                "qualification-start" -> {
                    require(json.length() == 2) { "Malformed qualification start" }
                    QualificationStart(QualificationMode.valueOf(json.getString("mode")))
                }
                "qualification-rendered" -> {
                    require(json.length() == 5) { "Malformed qualification render acknowledgement" }
                    QualificationRendered(
                        json.getString("sessionId").also { require(it.isNotEmpty()) },
                        json.getLong("revision").also { require(it > 0) },
                        json.getInt("stepIndex").also { require(it in QualificationStep.entries.indices) },
                        QualificationPhase.valueOf(json.getString("phase")),
                    )
                }
                "semantic-received" -> {
                    require(json.length() == 4) { "Malformed semantic receipt" }
                    SemanticReceived(
                        SemanticControl.valueOf(json.getString("control")),
                        SemanticAction.valueOf(json.getString("action")),
                        json.getLong("interactionId").also { require(it > 0) },
                    )
                }
                else -> error("Unknown bridge message")
            }
        }

        private fun parseProbe(json: JSONObject): ProbeResult {
            require(json.length() == 4 && json.has("passed") && json.has("checks") && json.has("details")) {
                "Malformed probe result"
            }
            val checksJson = json.getJSONObject("checks")
            val detailsJson = json.getJSONObject("details")
            require(json.get("passed") is Boolean) { "Probe passed must be Boolean" }
            require(checksJson.keys().asSequence().all { checksJson.get(it) is Boolean }) {
                "Probe checks must be Boolean"
            }
            require(detailsJson.keys().asSequence().all { detailsJson.get(it) is String }) {
                "Probe details must be strings"
            }
            val checks = checksJson.keys().asSequence().associateWith { checksJson.getBoolean(it) }
            val details = detailsJson.keys().asSequence().associateWith { detailsJson.getString(it) }
            val passed = json.getBoolean("passed")
            require(checks.keys == REQUIRED_CHECKS && details.keys == REQUIRED_CHECKS) { "Unexpected probe checks" }
            require(passed == checks.values.all { it }) { "Contradictory probe result" }
            return ProbeResult(passed, checks, details)
        }
    }
}
