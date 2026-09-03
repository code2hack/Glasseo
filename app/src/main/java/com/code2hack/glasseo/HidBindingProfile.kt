package com.code2hack.glasseo

import org.json.JSONArray
import org.json.JSONObject

const val HID_BINDING_SCHEMA_VERSION = 1

data class HidBindingProfile(
    val schemaVersion: Int = HID_BINDING_SCHEMA_VERSION,
    val bindings: Map<SemanticControl, HidPhysicalIdentity> = emptyMap(),
    val revision: Long = 0,
    val updatedAtMillis: Long = 0,
) {
    fun validated(): HidBindingProfile = apply {
        require(schemaVersion == HID_BINDING_SCHEMA_VERSION) { "Unsupported HID binding schema" }
        require(revision >= 0 && updatedAtMillis >= 0) { "Invalid HID binding metadata" }
        bindings.values.forEach(HidPhysicalIdentity::requirePersistable)
        require(bindings.values.distinctBy(HidPhysicalIdentity::stableKey).size == bindings.size) {
            "Duplicate HID binding"
        }
    }

    fun controlFor(identity: HidPhysicalIdentity): SemanticControl? =
        bindings.entries.firstOrNull { it.value.sameControl(identity) }?.key
}

object HidBindingProfileCodec {
    fun encode(profile: HidBindingProfile): String {
        profile.validated()
        val bindings = JSONArray()
        SemanticControl.entries.forEach { control ->
            profile.bindings[control]?.let { identity ->
                bindings.put(
                    JSONObject()
                        .put("control", control.name)
                        .put("descriptor", identity.descriptor)
                        .put("vendorId", identity.vendorId)
                        .put("productId", identity.productId)
                        .put("sourceMask", identity.sources)
                        .put("keyCode", identity.keyCode)
                        .put("scanCode", identity.scanCode),
                )
            }
        }
        return JSONObject()
            .put("schemaVersion", profile.schemaVersion)
            .put("revision", profile.revision)
            .put("updatedAtMillis", profile.updatedAtMillis)
            .put("bindings", bindings)
            .toString()
    }

    fun decode(value: String): HidBindingProfile {
        val json = JSONObject(value)
        require(json.keys().asSequence().toSet() == PROFILE_KEYS) { "Malformed HID profile" }
        val decoded = buildMap {
            val bindings = json.getJSONArray("bindings")
            repeat(bindings.length()) { index ->
                val item = bindings.getJSONObject(index)
                require(item.keys().asSequence().toSet() == BINDING_KEYS) { "Malformed HID binding" }
                val control = SemanticControl.valueOf(item.getString("control"))
                require(!containsKey(control)) { "Duplicate semantic control" }
                put(
                    control,
                    HidPhysicalIdentity(
                        descriptor = item.getString("descriptor"),
                        vendorId = item.getInt("vendorId"),
                        productId = item.getInt("productId"),
                        keyCode = item.getInt("keyCode"),
                        scanCode = item.getInt("scanCode"),
                        sources = item.getInt("sourceMask"),
                    ),
                )
            }
        }
        return HidBindingProfile(
            schemaVersion = json.getInt("schemaVersion"),
            bindings = decoded,
            revision = json.getLong("revision"),
            updatedAtMillis = json.getLong("updatedAtMillis"),
        ).validated()
    }

    private val PROFILE_KEYS = setOf("schemaVersion", "revision", "updatedAtMillis", "bindings")
    private val BINDING_KEYS = setOf(
        "control",
        "descriptor",
        "vendorId",
        "productId",
        "sourceMask",
        "keyCode",
        "scanCode",
    )
}

internal fun HidPhysicalIdentity.requirePersistable() {
    require(descriptor.isNotBlank() && descriptor.length <= 512) { "Invalid HID descriptor" }
    require(vendorId in 0..0xffff && productId in 0..0xffff) { "Invalid HID vendor/product" }
    require(keyCode > 0 && scanCode >= 0) { "Invalid HID key identity" }
    require(sources > 0 && (sources and HID_SOURCE_CLASS_MASK) != 0) { "Unsupported HID source" }
}

internal fun HidPhysicalIdentity.stableKey() =
    listOf(descriptor, vendorId, productId, keyCode, scanCode).joinToString("\u0000")

// Android InputDevice SOURCE_CLASS_BUTTON | SOURCE_CLASS_JOYSTICK.
private const val HID_SOURCE_CLASS_MASK = 0x00000011
