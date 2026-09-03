package com.code2hack.glasseo

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

object NativeHidBindingMessage {
    private val builtInCapabilities = mapOf(
        SemanticControl.PRIMARY to "UNAVAILABLE_BUILTIN",
        SemanticControl.SECONDARY to "UNAVAILABLE_BUILTIN",
        SemanticControl.COMMAND to "AVAILABLE_WITH_SUPPRESSION",
        SemanticControl.LEFT to "UNAVAILABLE_BUILTIN",
        SemanticControl.RIGHT to "UNAVAILABLE_BUILTIN",
        SemanticControl.UP to "AVAILABLE_SAFE",
        SemanticControl.DOWN to "AVAILABLE_SAFE",
    )

    fun state(profile: HidBindingProfile, connected: (HidPhysicalIdentity) -> Boolean): String {
        val bindings = JSONArray()
        SemanticControl.entries.forEach { control ->
            val identity = profile.bindings[control]
            bindings.put(
                JSONObject()
                    .put("control", control.name)
                    .put("label", identity?.displayLabel() ?: JSONObject.NULL)
                    .put("connected", identity?.let(connected) ?: false)
                    .put("builtInCapability", builtInCapabilities.getValue(control)),
            )
        }
        return JSONObject()
            .put("type", "hid-bindings-state")
            .put("revision", profile.revision)
            .put("bindings", bindings)
            .toString()
    }

    fun capture(snapshot: HidBindingCaptureSnapshot): String = JSONObject()
        .put("type", "hid-binding-capture-state")
        .put("requestId", snapshot.requestId ?: JSONObject.NULL)
        .put("control", snapshot.control?.name ?: JSONObject.NULL)
        .put("phase", snapshot.phase.name.lowercase(Locale.ROOT).replace('_', '-'))
        .put("revision", snapshot.profileRevision)
        .put("candidateLabel", snapshot.candidateLabel ?: JSONObject.NULL)
        .put("error", snapshot.error ?: JSONObject.NULL)
        .toString()

    fun reset(requestId: String, mutation: HidBindingMutation): String = JSONObject()
        .put("type", "hid-bindings-reset-result")
        .put("requestId", requestId)
        .put("status", if (mutation.status == HidBindingStatus.RESET) "ok" else "storage_error")
        .put("revision", mutation.profile.revision)
        .toString()

    private fun HidPhysicalIdentity.displayLabel() =
        "Key $keyCode/$scanCode · %04x:%04x".format(vendorId, productId)
}
