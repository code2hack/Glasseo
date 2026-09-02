package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HidQualificationFlowTest {
    private val peripheral = HidPeripheralIdentity("joy-con", 1406, 8199, 16_778_513)
    private val bindingOrder = listOf(
        SemanticControl.PRIMARY,
        SemanticControl.SECONDARY,
        SemanticControl.COMMAND,
        SemanticControl.UP,
        SemanticControl.DOWN,
        SemanticControl.LEFT,
        SemanticControl.RIGHT,
    )
    private val identities = bindingOrder.mapIndexed { index, control ->
        control to HidPhysicalIdentity(
            peripheral.descriptor,
            peripheral.vendorId,
            peripheral.productId,
            96 + index,
            304 + index,
            peripheral.sources,
        )
    }.toMap()

    @Test fun sevenSingleShortCyclesCreateSevenDistinctBindingsWithoutSettleOrRepeats() {
        val flow = HidQualificationFlow("hid-session", peripheral)

        bindingOrder.forEachIndexed { index, control ->
            acknowledgeReady(flow)
            val identity = identities.getValue(control)
            val downAt = index * 1_000L

            val down = flow.handle(input(identity, PhysicalAction.DOWN, downAt))
            assertEquals("DOWN received; waiting for matching UP", down.reason)
            assertFalse(down.snapshotChanged)

            val up = flow.handle(input(identity, PhysicalAction.UP, downAt + 25))
            assertEquals("Complete DOWN/UP received and accepted: ${control.name} bound", up.reason)
            assertTrue(up.snapshotChanged)
            assertEquals(identity, flow.bindings.identityFor(control))
            assertEquals(index + 1, flow.bindings.size)
            assertEquals(null, flow.snapshot.settleDeadlineMillis)

            acknowledgeTransition(flow)
        }

        assertEquals(HidQualificationStage.RECOGNITION, flow.snapshot.stage)
        assertEquals(QualificationStep.SHORT_PRIMARY, flow.snapshot.recognitionStep)
        assertEquals(7, flow.bindings.size)
    }

    @Test fun completeNoRepeatCyclesFromTwoToThreeHundredMillisBindAndRecognizeAsShort() {
        listOf(2L, 20L, 80L, 150L, 300L).forEach { duration ->
            val flow = bindAll(duration)
            acknowledgeReady(flow)
            val primary = identities.getValue(SemanticControl.PRIMARY)

            assertEquals(
                "down-accepted",
                flow.handle(input(primary, PhysicalAction.DOWN, 20_000)).reason,
            )
            val up = flow.handle(input(primary, PhysicalAction.UP, 20_000 + duration))

            assertEquals(BehaviorClass.SHORT, (up.operation?.signature as HidOperationSignature).behavior)
            assertTrue(up.snapshotChanged)
            assertEquals(QualificationStep.LONG_PRIMARY, flow.snapshot.recognitionStep)
        }
    }

    @Test fun bindingAcceptsA485MillisShortPressWithAndroidRepeats() {
        val flow = HidQualificationFlow("hid-session", peripheral)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        acknowledgeReady(flow)

        flow.handle(input(primary, PhysicalAction.DOWN, 1_000))
        flow.handle(input(primary, PhysicalAction.REPEAT, 1_401, repeatCount = 1))
        flow.handle(input(primary, PhysicalAction.REPEAT, 1_452, repeatCount = 2))
        val up = flow.handle(input(primary, PhysicalAction.UP, 1_485))

        assertEquals("Complete DOWN/UP received and accepted: PRIMARY bound", up.reason)
        assertEquals(primary, flow.bindings.identityFor(SemanticControl.PRIMARY))
    }

    @Test fun shortRecognitionUsesDownToUpDurationWhenAndroidRepeats() {
        val flow = bindAll(20)
        acknowledgeReady(flow)
        val primary = identities.getValue(SemanticControl.PRIMARY)

        flow.handle(input(primary, PhysicalAction.DOWN, 20_000))
        flow.handle(input(primary, PhysicalAction.REPEAT, 20_401, repeatCount = 1))
        flow.handle(input(primary, PhysicalAction.REPEAT, 20_452, repeatCount = 2))
        val up = flow.handle(input(primary, PhysicalAction.UP, 20_485))

        assertEquals(BehaviorClass.SHORT, (up.operation?.signature as HidOperationSignature).behavior)
    }

    @Test fun longRecognitionUsesDownToUpDurationWhenAndroidRepeats() {
        val flow = bindAll(20)
        completeRecognition(flow, QualificationStep.SHORT_PRIMARY, 20)
        acknowledgeReady(flow)
        val primary = identities.getValue(SemanticControl.PRIMARY)

        flow.handle(input(primary, PhysicalAction.DOWN, 30_000))
        flow.handle(input(primary, PhysicalAction.REPEAT, 30_401, repeatCount = 1))
        flow.handle(input(primary, PhysicalAction.REPEAT, 30_452, repeatCount = 2))
        val up = flow.handle(input(primary, PhysicalAction.UP, 30_700))

        assertEquals(BehaviorClass.LONG, (up.operation?.signature as HidOperationSignature).behavior)
    }

    @Test fun mismatchedOwnerRepeatCannotCorruptAnAdmittedRecognitionPress() {
        val flow = bindAll(20)
        acknowledgeReady(flow)
        val primary = identities.getValue(SemanticControl.PRIMARY)

        flow.handle(input(primary, PhysicalAction.DOWN, 20_000, deviceId = 6))
        val repeat = flow.handle(input(primary, PhysicalAction.REPEAT, 20_100, deviceId = 7, repeatCount = 1))
        val up = flow.handle(input(primary, PhysicalAction.UP, 20_300, deviceId = 6))

        assertEquals("repeat-ignored", repeat.reason)
        assertEquals(BehaviorClass.SHORT, (up.operation?.signature as HidOperationSignature).behavior)
    }

    @Test fun mismatchedOwnerOrIdentityRepeatsCannotPoisonAnAdmittedBindingPress() {
        val flow = HidQualificationFlow("hid-session", peripheral)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        val secondary = identities.getValue(SemanticControl.SECONDARY)
        acknowledgeReady(flow)

        flow.handle(input(primary, PhysicalAction.DOWN, 1_000, deviceId = 6))
        val wrongOwner = flow.handle(input(primary, PhysicalAction.REPEAT, 1_100, deviceId = 7, repeatCount = 1))
        val wrongIdentity = flow.handle(input(secondary, PhysicalAction.REPEAT, 1_200, deviceId = 6, repeatCount = 2))
        val up = flow.handle(input(primary, PhysicalAction.UP, 1_300, deviceId = 6))

        assertEquals("Rejected: repeat does not match admitted DOWN", wrongOwner.reason)
        assertEquals("Rejected: repeat does not match admitted DOWN", wrongIdentity.reason)
        assertEquals("Complete DOWN/UP received and accepted: PRIMARY bound", up.reason)
    }

    @Test fun mismatchedOwnerOrIdentityCancelsCannotPoisonAnAdmittedBindingPress() {
        val flow = HidQualificationFlow("hid-session", peripheral)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        val secondary = identities.getValue(SemanticControl.SECONDARY)
        acknowledgeReady(flow)

        flow.handle(input(primary, PhysicalAction.DOWN, 1_000, deviceId = 6))
        val wrongOwner = flow.handle(input(primary, PhysicalAction.CANCEL, 1_100, deviceId = 7))
        val wrongIdentity = flow.handle(input(secondary, PhysicalAction.CANCEL, 1_200, deviceId = 6))
        val up = flow.handle(input(primary, PhysicalAction.UP, 1_300, deviceId = 6))

        assertEquals("Rejected: CANCEL does not match admitted DOWN", wrongOwner.reason)
        assertEquals("Rejected: CANCEL does not match admitted DOWN", wrongIdentity.reason)
        assertEquals("Complete DOWN/UP received and accepted: PRIMARY bound", up.reason)
    }

    @Test fun matchingBindingCancelMakesItsLateUpInert() {
        val flow = HidQualificationFlow("hid-session", peripheral)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        acknowledgeReady(flow)

        flow.handle(input(primary, PhysicalAction.DOWN, 1_000))
        val cancel = flow.handle(input(primary, PhysicalAction.CANCEL, 1_100))
        val lateUp = flow.handle(input(primary, PhysicalAction.UP, 1_200))

        assertEquals("Input cancelled", cancel.reason)
        assertEquals("Rejected: UP without DOWN", lateUp.reason)
        assertEquals(0, flow.bindings.size)
    }

    @Test fun mismatchedOwnerCancelCannotCorruptAnAdmittedRecognitionPress() {
        val flow = bindAll(20)
        acknowledgeReady(flow)
        val primary = identities.getValue(SemanticControl.PRIMARY)

        flow.handle(input(primary, PhysicalAction.DOWN, 20_000, deviceId = 6))
        val cancel = flow.handle(input(primary, PhysicalAction.CANCEL, 20_100, deviceId = 7))
        val up = flow.handle(input(primary, PhysicalAction.UP, 20_300, deviceId = 6))

        assertEquals("action-ignored", cancel.reason)
        assertEquals(BehaviorClass.SHORT, (up.operation?.signature as HidOperationSignature).behavior)
    }

    @Test fun recognitionUsesLockedBindingAndDoubleNeedsTwoCyclesWithoutIntermediateRenderAck() {
        val flow = bindAll(20)
        val originalBindings = flow.bindings.snapshot()
        completeRecognition(flow, QualificationStep.SHORT_PRIMARY, 20)
        completeRecognition(flow, QualificationStep.LONG_PRIMARY, 700)
        completeRecognition(flow, QualificationStep.LONG_SECONDARY, 700)
        acknowledgeReady(flow)
        val secondary = identities.getValue(SemanticControl.SECONDARY)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        val revision = flow.snapshot.revision

        assertEquals(
            "Rejected: expected SECONDARY but received PRIMARY",
            flow.handle(input(primary, PhysicalAction.DOWN, 30_000)).reason,
        )
        flow.handle(input(secondary, PhysicalAction.DOWN, 30_100))
        val first = flow.handle(input(secondary, PhysicalAction.UP, 30_120))
        assertEquals("First complete SECONDARY cycle accepted; waiting for second cycle", first.reason)
        assertFalse(first.snapshotChanged)
        assertEquals(revision, flow.snapshot.revision)

        flow.handle(input(secondary, PhysicalAction.DOWN, 30_250))
        val second = flow.handle(input(secondary, PhysicalAction.UP, 30_270))

        assertEquals(BehaviorClass.DOUBLE, (second.operation?.signature as HidOperationSignature).behavior)
        assertEquals(2, second.operation?.hidPresses?.size)
        assertTrue(second.snapshotChanged)
        assertEquals(originalBindings, flow.bindings.snapshot())
        assertEquals(1, flow.operations.getValue(QualificationStep.DOUBLE_SECONDARY).hidCaptures.size)
    }

    @Test fun admittedDownKeepsItsMatchingUpWhenCaptureIsSuspended() {
        val flow = bindAll(20)
        acknowledgeReady(flow)
        val primary = identities.getValue(SemanticControl.PRIMARY)
        flow.handle(input(primary, PhysicalAction.DOWN, 40_000))

        flow.suspendCapture()
        val up = flow.handle(input(primary, PhysicalAction.UP, 40_020))

        assertEquals(BehaviorClass.SHORT, (up.operation?.signature as HidOperationSignature).behavior)
        assertTrue(up.snapshotChanged)
    }

    @Test fun completeRecognitionProducesOneCapturePerStepAndPassesAfterTransientDeviceIdChange() {
        val flow = bindAll(20)
        var time = 50_000L
        QualificationStep.entries.forEach { step ->
            acknowledgeReady(flow)
            val identity = identities.getValue(step.control).copy(sources = peripheral.sources xor 0x100)
            val duration = if (step.behavior == BehaviorClass.LONG) 700L else 20L
            flow.handle(input(identity, PhysicalAction.DOWN, time, deviceId = 9))
            flow.handle(input(identity, PhysicalAction.UP, time + duration, deviceId = 9))
            if (step == QualificationStep.DOUBLE_SECONDARY) {
                time += duration + 100
                flow.handle(input(identity, PhysicalAction.DOWN, time, deviceId = 9))
                flow.handle(input(identity, PhysicalAction.UP, time + duration, deviceId = 9))
            }
            if (step != QualificationStep.RIGHT) acknowledgeTransition(flow)
            time += 1_000
        }

        assertEquals(HidQualificationStage.COMPLETE, flow.snapshot.stage)
        val result = checkNotNull(flow.result())
        assertTrue(result.passes)
        assertTrue(result.operations.values.all { it.hidCaptures.size == 1 })
        assertEquals(7, result.bindings.size)
    }

    private fun acknowledgeReady(flow: HidQualificationFlow) {
        val result = flow.acknowledge(flow.snapshot.ack())
        assertTrue(result.accepted)
        assertTrue(result.armed)
    }

    private fun acknowledgeTransition(flow: HidQualificationFlow) {
        assertEquals(HidQualificationPhase.STEP_CONFIRMED, flow.snapshot.phase)
        val transition = flow.acknowledge(flow.snapshot.ack())
        assertTrue(transition.accepted)
        assertTrue(transition.snapshotChanged)
        assertFalse(transition.armed)
    }

    private fun bindAll(duration: Long): HidQualificationFlow {
        val flow = HidQualificationFlow("hid-session-$duration", peripheral)
        bindingOrder.forEachIndexed { index, control ->
            acknowledgeReady(flow)
            val downAt = index * 1_000L
            flow.handle(input(identities.getValue(control), PhysicalAction.DOWN, downAt))
            flow.handle(input(identities.getValue(control), PhysicalAction.UP, downAt + duration))
            acknowledgeTransition(flow)
        }
        return flow
    }

    private fun completeRecognition(flow: HidQualificationFlow, step: QualificationStep, duration: Long) {
        assertEquals(step, flow.snapshot.recognitionStep)
        acknowledgeReady(flow)
        val identity = identities.getValue(step.control)
        val downAt = 10_000L + step.ordinal * 1_000L
        flow.handle(input(identity, PhysicalAction.DOWN, downAt))
        val result = flow.handle(input(identity, PhysicalAction.UP, downAt + duration))
        assertEquals(step.behavior, (result.operation?.signature as HidOperationSignature).behavior)
        acknowledgeTransition(flow)
    }

    private fun input(
        identity: HidPhysicalIdentity,
        action: PhysicalAction,
        time: Long,
        deviceId: Int = 6,
        repeatCount: Int = 0,
    ) = HidRawInput(
        action,
        identity,
        deviceId = deviceId,
        repeatCount = repeatCount,
        eventTimeMillis = time,
        receivedElapsedRealtimeMillis = time,
    )

    private fun HidQualificationSnapshot.ack() = HidQualificationRenderAck(
        sessionId,
        revision,
        stage,
        stepIndex,
        phase,
    )
}
