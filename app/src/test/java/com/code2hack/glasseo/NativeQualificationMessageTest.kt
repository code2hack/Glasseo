package com.code2hack.glasseo

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test fun rollingHidTraceEncodesExactRawTimingAndDecision() {
        val identity = HidPhysicalIdentity("joy-con", 1406, 8199, 105, 313, 0x01000511)
        val trace = HidInputTraceRecorder(limit = 2)

        val down = trace.record(
            HidRawInput(PhysicalAction.DOWN, identity, 6, 0, 100, 102),
            "secondary-down:first-tap",
        )
        val up = trace.record(
            HidRawInput(PhysicalAction.UP, identity, 6, 0, 200, 203),
            "secondary-up:awaiting-second-tap duration=100ms",
        )
        val nextDown = trace.record(
            HidRawInput(PhysicalAction.DOWN, identity, 6, 0, 480, 482),
            "secondary-down:confirmation gap=280ms",
        )

        assertNull(down.pressDurationMillis)
        assertEquals(100L, up.pressDurationMillis)
        assertEquals(280L, nextDown.releaseToNextDownMillis)
        assertEquals(listOf(up, nextDown), trace.snapshot())

        val json = JSONObject(NativeQualificationMessage.hidInputTrace(trace.snapshot()))
        assertEquals("hid-input-trace", json.getString("type"))
        val encoded = json.getJSONArray("events").getJSONObject(1)
        assertEquals("DOWN", encoded.getString("action"))
        assertEquals(105, encoded.getInt("keyCode"))
        assertEquals(313, encoded.getInt("scanCode"))
        assertEquals(0, encoded.getInt("repeatCount"))
        assertEquals(480L, encoded.getLong("eventTimeMillis"))
        assertEquals(482L, encoded.getLong("receivedElapsedRealtimeMillis"))
        assertEquals(0x01000511, encoded.getInt("eventSource"))
        assertEquals(6, encoded.getInt("deviceId"))
        assertEquals("joy-con", encoded.getString("descriptor"))
        assertEquals(1406, encoded.getInt("vendorId"))
        assertEquals(8199, encoded.getInt("productId"))
        assertEquals(0x01000511, encoded.getInt("sources"))
        assertEquals("HID", encoded.getString("physicalSource"))
        assertTrue(encoded.isNull("pressDurationMillis"))
        assertEquals(280L, encoded.getLong("releaseToNextDownMillis"))
        assertEquals("secondary-down:confirmation gap=280ms", encoded.getString("reason"))
    }
}
