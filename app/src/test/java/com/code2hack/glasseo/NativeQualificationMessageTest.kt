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

        val downReceipt = trace.recordRaw(HidRawInput(PhysicalAction.DOWN, identity, 6, 0, 100, 102))
        trace.recordDecision(downReceipt.sequence, "secondary-down:first-tap")
        val upReceipt = trace.recordRaw(HidRawInput(PhysicalAction.UP, identity, 6, 0, 200, 203))
        trace.recordDecision(upReceipt.sequence, "secondary-up:awaiting-second-tap duration=100ms")
        val nextDownReceipt = trace.recordRaw(HidRawInput(PhysicalAction.DOWN, identity, 6, 0, 480, 482))
        trace.recordDecision(nextDownReceipt.sequence, "secondary-down:confirmation gap=280ms")
        val snapshot = trace.snapshot()
        val (up, nextDown) = snapshot.events

        assertNull(downReceipt.pressDurationMillis)
        assertEquals(100L, up.receipt.pressDurationMillis)
        assertEquals(280L, nextDown.receipt.releaseToNextDownMillis)
        assertEquals(3, snapshot.totalRawReceipts)
        assertEquals(3, snapshot.totalDecisions)
        assertEquals(0, snapshot.droppedRecords)
        assertEquals(3, trace.allRawReceipts().size)
        assertEquals(3, trace.allDecisions().size)

        trace.startAttempt(
            "A01",
            QualificationStep.SHORT_PRIMARY,
            HidQualificationPhase.AWAITING_INPUT,
            identity.peripheral,
            identity,
            490,
            500,
            1_500,
        )
        trace.expireAttempt("A01", 2_000)
        val attempt = trace.snapshot().attempt
        assertEquals(QualificationStep.SHORT_PRIMARY, attempt?.operation)
        assertEquals(HidQualificationPhase.AWAITING_INPUT, attempt?.phase)
        assertEquals(490L, attempt?.supervisorElapsedRealtimeMillis)
        assertEquals(HidAttemptStatus.NO_ANDROID_EVENT, attempt?.status)
        val encodedSnapshot = trace.snapshot()

        trace.startAttempt(
            "A02",
            QualificationStep.SHORT_PRIMARY,
            HidQualificationPhase.AWAITING_INPUT,
            identity.peripheral,
            identity,
            2_100,
            2_110,
            1_500,
        )
        trace.recordRaw(HidRawInput(PhysicalAction.DOWN, identity.copy(keyCode = 106), 6, 0, 2_200, 2_202))
        assertEquals(HidAttemptStatus.AWAITING_ANDROID_EVENT, trace.snapshot().attempt?.status)
        val matching = trace.recordRaw(HidRawInput(PhysicalAction.DOWN, identity, 6, 0, 2_300, 2_302))
        assertEquals(HidAttemptStatus.ANDROID_EVENT_RECEIVED, trace.snapshot().attempt?.status)
        assertEquals(matching.sequence, trace.snapshot().attempt?.firstRawSequence)

        val json = JSONObject(NativeQualificationMessage.hidInputTrace(encodedSnapshot))
        assertEquals("hid-input-trace", json.getString("type"))
        assertEquals(3, json.getInt("totalRawReceipts"))
        assertEquals(3, json.getInt("totalDecisions"))
        assertEquals(0, json.getInt("droppedRecords"))
        val encodedAttempt = json.getJSONObject("attempt")
        assertEquals("SHORT_PRIMARY", encodedAttempt.getString("operation"))
        assertEquals("AWAITING_INPUT", encodedAttempt.getString("phase"))
        assertEquals(490L, encodedAttempt.getLong("supervisorElapsedRealtimeMillis"))
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
