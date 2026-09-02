package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HidQualificationCaptureTest {
    private val identity = HidPhysicalIdentity("keyboard", 1, 2, 66, 28)
    private val owner = PhysicalOwner(PhysicalSource.HID, 9, 66)

    @Test fun usesClassifierTimingBoundaries() {
        val short = HidQualificationCapture()
        short.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)
        assertEquals(
            BehaviorClass.SHORT,
            short.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 599)?.signature?.behavior,
        )

        val long = HidQualificationCapture()
        long.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)
        assertEquals(
            BehaviorClass.LONG,
            long.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 600)?.signature?.behavior,
        )
    }

    @Test fun cancellationAndLateUpProduceNoOperation() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)
        capture.cancelAll(100)
        assertNull(capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 200))
    }
}
