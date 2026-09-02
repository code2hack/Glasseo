package com.code2hack.glasseo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class NativeSemanticMessageTest {
    @Test fun exposesOnlyNormalizedSemanticFields() {
        val json = JSONObject(
            NativeSemanticMessage.encode(
                SemanticInteraction(SemanticControl.PRIMARY, SemanticAction.SHORT, 7, 123),
            ),
        )
        assertEquals(setOf("type", "control", "action", "interactionId", "timeMillis"), json.keys().asSequence().toSet())
        assertEquals("semantic-input", json.getString("type"))
        assertEquals("PRIMARY", json.getString("control"))
        assertEquals("SHORT", json.getString("action"))
    }
}
