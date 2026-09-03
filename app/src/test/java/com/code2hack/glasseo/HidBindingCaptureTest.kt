package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HidBindingCaptureTest {
    private val primary = identity(96, 304)

    @Test fun completeShortPairCommitsAndRepeatsDoNotChangeIdentity() {
        val store = store()
        val capture = HidBindingCapture(store)
        capture.start(SemanticControl.PRIMARY, "bind_1", 0)

        assertEquals(HidBindingCapturePhase.AWAITING_UP, capture.handle(input(primary, PhysicalAction.DOWN, 10)).phase)
        assertEquals(HidBindingCapturePhase.AWAITING_UP, capture.handle(input(primary, PhysicalAction.REPEAT, 200)).phase)
        assertEquals(HidBindingCapturePhase.COMMITTED, capture.handle(input(primary, PhysicalAction.UP, 300)).phase)
        assertEquals(primary, store.profile.bindings[SemanticControl.PRIMARY])
    }

    @Test fun duplicateMismatchedUpLongPressDisconnectAndTimeoutCannotMutateProfile() {
        val store = store()
        assertEquals(HidBindingStatus.BOUND, store.bind(SemanticControl.PRIMARY, primary).status)
        val revision = store.profile.revision
        val capture = HidBindingCapture(store, timeoutMillis = 100)

        capture.start(SemanticControl.SECONDARY, "duplicate", 0)
        capture.handle(input(primary, PhysicalAction.DOWN, 1))
        assertEquals(HidBindingCapturePhase.DUPLICATE, capture.handle(input(primary, PhysicalAction.UP, 2)).phase)
        capture.start(SemanticControl.SECONDARY, "mismatch", 10)
        capture.handle(input(identity(97, 305), PhysicalAction.DOWN, 11))
        assertEquals(
            HidBindingCapturePhase.INVALID,
            capture.handle(input(identity(98, 306), PhysicalAction.UP, 12)).phase,
        )
        capture.start(SemanticControl.SECONDARY, "long", 20)
        capture.handle(input(identity(97, 305), PhysicalAction.DOWN, 21))
        assertEquals(
            "binding_press_not_short",
            capture.handle(input(identity(97, 305), PhysicalAction.UP, 621)).error,
        )
        capture.start(SemanticControl.SECONDARY, "disconnect", 30)
        capture.handle(input(identity(97, 305), PhysicalAction.DOWN, 31, deviceId = 7))
        assertEquals(HidBindingCapturePhase.CANCELLED, capture.cancelDevice(7).phase)
        capture.start(SemanticControl.SECONDARY, "timeout", 100)
        assertEquals(HidBindingCapturePhase.TIMED_OUT, capture.advance(200).phase)

        assertEquals(revision, store.profile.revision)
        assertTrue(store.profile.bindings.keys == setOf(SemanticControl.PRIMARY))
    }

    private fun store() = HidBindingStore(null, { true }, { 1 })
    private fun identity(keyCode: Int, scanCode: Int) =
        HidPhysicalIdentity("joy-con", 1406, 8199, keyCode, scanCode, 0x1000511)
    private fun input(
        identity: HidPhysicalIdentity,
        action: PhysicalAction,
        time: Long,
        deviceId: Int = 6,
    ) = HidRawInput(action, identity, deviceId, 0, time, time)
}
