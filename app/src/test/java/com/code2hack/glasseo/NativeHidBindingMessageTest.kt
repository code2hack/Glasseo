package com.code2hack.glasseo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeHidBindingMessageTest {
    @Test fun stateContainsSevenRedactedBindingsAndAcceptedBuiltInMatrix() {
        val identity = HidPhysicalIdentity("secret-descriptor", 1406, 8199, 96, 304, 0x1000511)
        val json = JSONObject(
            NativeHidBindingMessage.state(
                HidBindingProfile(bindings = mapOf(SemanticControl.PRIMARY to identity), revision = 1),
            ) { true },
        )
        val bindings = json.getJSONArray("bindings")

        assertEquals(7, bindings.length())
        assertEquals("Key 96/304 · 057e:2007", bindings.getJSONObject(0).getString("label"))
        assertEquals("UNAVAILABLE_BUILTIN", bindings.getJSONObject(0).getString("builtInCapability"))
        assertEquals("AVAILABLE_WITH_SUPPRESSION", bindings.getJSONObject(2).getString("builtInCapability"))
        assertEquals("AVAILABLE_SAFE", bindings.getJSONObject(5).getString("builtInCapability"))
        assertFalse(json.toString().contains("secret-descriptor"))
        assertTrue(bindings.getJSONObject(1).isNull("label"))
    }
}
