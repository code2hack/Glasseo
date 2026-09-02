package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    @Test fun competingOwnerCannotReplaceTheActivePhysicalIdentity() {
        val capture = HidQualificationCapture()
        val competingOwner = PhysicalOwner(PhysicalSource.HID, 10, 67)
        val competingIdentity = identity.copy(keyCode = 67, scanCode = 14)
        capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)

        assertEquals(
            "down-ignored:active-owner=$owner",
            capture.handleDetailed(
                competingOwner,
                competingIdentity,
                SemanticControl.SECONDARY,
                PhysicalAction.DOWN,
                10,
            ).reason,
        )
        assertNull(
            capture.handle(
                competingOwner,
                competingIdentity,
                SemanticControl.SECONDARY,
                PhysicalAction.UP,
                20,
            ),
        )

        assertEquals(
            identity,
            (capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 100)
                ?.signature as HidOperationSignature).identity,
        )
    }

    @Test fun disconnectingAnotherDeviceDoesNotCancelTheActivePress() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)

        assertEquals(false, capture.cancelSource(PhysicalSource.HID, 10, 10))

        assertEquals(
            BehaviorClass.SHORT,
            capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 100)
                ?.signature?.behavior,
        )
    }

    @Test fun operationRecordsMonotonicPressTimingOutsideTheStableSignature() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 100)

        val operation = capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 450)!!

        assertEquals(listOf(HidPressTiming(100, 450)), operation.hidPresses)
        assertEquals(HidOperationSignature(identity, BehaviorClass.SHORT), operation.signature)
    }

    @Test fun doubleSecondaryRecordsBothPhysicalPresses() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.SECONDARY, PhysicalAction.DOWN, 0)
        assertNull(capture.handle(owner, identity, SemanticControl.SECONDARY, PhysicalAction.UP, 100))
        capture.handle(owner, identity, SemanticControl.SECONDARY, PhysicalAction.DOWN, 300)

        val operation = capture.handle(owner, identity, SemanticControl.SECONDARY, PhysicalAction.UP, 350)!!

        assertEquals(BehaviorClass.DOUBLE, operation.signature.behavior)
        assertEquals(listOf(HidPressTiming(0, 100), HidPressTiming(300, 350)), operation.hidPresses)
    }

    @Test fun physicalSecondaryDoubleSurvivesAStaleRenderAckWithoutRepeats() {
        val bindings = HidBindingMap().apply { assertTrue(bind(SemanticControl.SECONDARY, identity)) }
        val session = QualificationSession(
            QualificationMode.HID,
            "secondary-double",
            bindings,
            QualificationStep.DOUBLE_SECONDARY.ordinal,
            nowMillis = { 1_000L },
        )
        assertTrue(
            session.acknowledge(
                QualificationRenderAck(
                    "secondary-double",
                    session.snapshot.revision,
                    QualificationStep.DOUBLE_SECONDARY.ordinal,
                    QualificationPhase.AWAITING_FIRST,
                ),
            ).accepted,
        )
        val capture = HidQualificationCapture()

        assertEquals(
            "secondary-down:first-tap",
            capture.handleDetailed(
                owner,
                identity,
                SemanticControl.SECONDARY,
                PhysicalAction.DOWN,
                100,
            ).reason,
        )
        assertEquals(
            "secondary-up:awaiting-second-tap duration=100ms",
            capture.handleDetailed(
                owner,
                identity,
                SemanticControl.SECONDARY,
                PhysicalAction.UP,
                200,
            ).reason,
        )
        assertFalse(
            session.acknowledge(
                QualificationRenderAck(
                    "secondary-double",
                    session.snapshot.revision - 1,
                    QualificationStep.DOUBLE_SECONDARY.ordinal,
                    QualificationPhase.AWAITING_FIRST,
                ),
            ).accepted,
        )
        assertTrue(session.armed)
        assertEquals(
            "secondary-down:confirmation gap=280ms",
            capture.handleDetailed(
                owner,
                identity,
                SemanticControl.SECONDARY,
                PhysicalAction.DOWN,
                480,
            ).reason,
        )
        val secondUp = capture.handleDetailed(
            owner,
            identity,
            SemanticControl.SECONDARY,
            PhysicalAction.UP,
            620,
        )

        assertEquals("accepted-DOUBLE duration=140ms gap=280ms", secondUp.reason)
        assertEquals(
            listOf(HidPressTiming(100, 200), HidPressTiming(480, 620)),
            secondUp.operation?.hidPresses,
        )
        assertTrue(session.capture(checkNotNull(secondUp.operation)) is CaptureAdmission.Accepted)
        assertEquals(QualificationPhase.SETTLING_FIRST, session.snapshot.phase)
    }

    @Test fun secondaryGapOutsideThresholdRestartsWithAnExactReason() {
        val capture = HidQualificationCapture()
        capture.handleDetailed(owner, identity, SemanticControl.SECONDARY, PhysicalAction.DOWN, 0)
        capture.handleDetailed(owner, identity, SemanticControl.SECONDARY, PhysicalAction.UP, 100)

        val nextDown = capture.handleDetailed(
            owner,
            identity,
            SemanticControl.SECONDARY,
            PhysicalAction.DOWN,
            451,
        )

        assertNull(nextDown.operation)
        assertEquals("secondary-down:gap-exceeded 351ms; restarted-first-tap", nextDown.reason)
    }

    @Test fun disconnectCancelsWithoutCompletionAndStableIdentitySurvivesNewDeviceId() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 0)
        assertEquals(true, capture.cancelSource(PhysicalSource.HID, owner.deviceId, 100))
        assertNull(capture.handle(owner, identity, SemanticControl.PRIMARY, PhysicalAction.UP, 200))

        val reconnectedOwner = owner.copy(deviceId = 42)
        capture.handle(reconnectedOwner, identity, SemanticControl.PRIMARY, PhysicalAction.DOWN, 300)
        val operation = capture.handle(
            reconnectedOwner,
            identity,
            SemanticControl.PRIMARY,
            PhysicalAction.UP,
            400,
        )!!

        assertEquals(identity, (operation.signature as HidOperationSignature).identity)
        assertEquals(listOf(HidPressTiming(300, 400)), operation.hidPresses)
    }

    @Test fun keyRepeatsDoNotCreateDuplicateQualificationOperations() {
        val capture = HidQualificationCapture()
        capture.handle(owner, identity, SemanticControl.UP, PhysicalAction.DOWN, 0)
        assertNull(capture.handle(owner, identity, SemanticControl.UP, PhysicalAction.REPEAT, 20))
        assertNull(capture.handle(owner, identity, SemanticControl.UP, PhysicalAction.REPEAT, 40))

        val operation = capture.handle(owner, identity, SemanticControl.UP, PhysicalAction.UP, 60)!!

        assertEquals(BehaviorClass.DIRECTIONAL, operation.signature.behavior)
        assertEquals(listOf(HidPressTiming(0, 60)), operation.hidPresses)
    }
}
