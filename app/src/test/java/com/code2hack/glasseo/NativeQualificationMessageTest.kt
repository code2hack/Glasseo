package com.code2hack.glasseo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NativeQualificationMessageTest {
    @Test fun encodesLandingAndWizardStateWithoutRawEvents() {
        assertEquals("qualification-landing", JSONObject(NativeQualificationMessage.landing()).getString("type"))

        val session = QualificationSession(
            QualificationMode.HID,
            "session-1",
            nowMillis = { 10_000L },
        )
        val json = JSONObject(NativeQualificationMessage.state(session.snapshot))
        assertEquals("qualification-state", json.getString("type"))
        assertEquals("session-1", json.getString("sessionId"))
        assertEquals(1L, json.getLong("revision"))
        assertEquals(0, json.getInt("stepIndex"))
        assertEquals("Short PRIMARY", json.getString("stepName"))
        assertEquals("AWAITING_FIRST", json.getString("phase"))
        assertEquals("Briefly use the intended PRIMARY control", json.getString("description"))
        assertEquals("Press the button you wanna bind", json.getString("prompt"))
        assertFalse(json.getBoolean("paused"))
        assertEquals(17, json.length())
        assertEquals("UP", QualificationStep.UP.displayName)
        assertEquals("DOWN", QualificationStep.DOWN.displayName)
        assertEquals("LEFT", QualificationStep.LEFT.displayName)
        assertEquals("RIGHT", QualificationStep.RIGHT.displayName)
    }
}
